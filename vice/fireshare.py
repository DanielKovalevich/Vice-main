from __future__ import annotations

import asyncio
import hashlib
import io
import json
import re
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Awaitable, Callable, Optional
from urllib.parse import urlparse

import aiohttp

from .library import ClipLibrary

ALLOWED_EXTENSIONS = {".mp4", ".m4v", ".mov", ".webm"}
FIRESHARE_FOLDER_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_AiohttpFormData = aiohttp.FormData


class FireShareError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        status: Optional[int] = None,
        payload: Optional[dict] = None,
        retry_after: Optional[int] = None,
        source_sha256: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.payload = payload or {}
        self.retry_after = retry_after
        # Populated by FireShareClient.upload() when the request body was
        # fully read from disk before the server responded with an error, so
        # a failed attempt still records the bytes it actually sent.
        self.source_sha256 = source_sha256


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def normalize_base_url(raw: str, *, require_https: bool = True) -> str:
    value = (raw or "").strip()
    if not value:
        raise ValueError("FireShare base URL is required")
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("FireShare base URL must be an absolute http(s) URL")
    if require_https and parsed.scheme != "https" and parsed.hostname not in {"localhost", "127.0.0.1"}:
        raise ValueError("FireShare base URL must use HTTPS")
    path = parsed.path.rstrip("/")
    if path.endswith("/api/v1"):
        path = path[:-7]
    return f"{parsed.scheme}://{parsed.netloc}{path}"


def render_title(template: str, clip_path: Path, game: str = "") -> str:
    now = datetime.now()
    return (
        (template or "$filename")
        .replace("$filename", clip_path.stem)
        .replace("$game", game or "")
        .replace("$date", now.strftime("%Y-%m-%d"))
        .replace("$time", now.strftime("%H%M"))
        .strip()
    )


def validate_folder_name(value: object, *, allow_empty: bool = False) -> str:
    if allow_empty and value == "":
        return ""
    if not isinstance(value, str) or not FIRESHARE_FOLDER_RE.fullmatch(value):
        raise ValueError(
            "FireShare folder must be 1-128 letters, numbers, underscores, or hyphens"
        )
    return value


class _ProgressFile(io.BufferedReader):
    """Wraps the clip file handle so aiohttp's chunked multipart reads (each
    a plain, synchronous ``read()`` call made from its executor thread) also
    drive upload progress *and* an incremental SHA-256 of the exact bytes
    sent — without ever holding more than one chunk in memory at a time."""

    def __init__(self, raw, total: int, on_progress: Callable[[int, int], None]) -> None:
        super().__init__(raw)
        self._total = max(0, int(total))
        self._sent = 0
        self._on_progress = on_progress
        self._hasher = hashlib.sha256()
        # A zero-byte file has nothing left to stream, so its digest (of the
        # empty string) is already complete without a single read() call.
        self._complete = self._sent >= self._total
        self._over_read = False

    def read(self, size: int = -1):  # type: ignore[override]
        chunk = super().read(size)
        if chunk:
            self._sent += len(chunk)
            self._hasher.update(chunk)
            self._on_progress(self._sent, self._total)
            if self._sent > self._total:
                # More bytes came back than the fstat'd size we started
                # with (e.g. the file grew mid-upload); the digest no
                # longer matches the exact contract the caller expects, so
                # never let it be reported as valid.
                self._over_read = True
            elif self._sent == self._total:
                self._complete = True
        return chunk

    @property
    def sha256_hex(self) -> Optional[str]:
        """The hash of everything read so far, but only once the cumulative
        bytes returned by ``read()`` reach exactly the total size recorded
        before the upload started.

        Real aiohttp payload wrappers (``BufferedReaderPayload`` /
        ``IOBasePayload.write_with_length``) fstat the file once for its
        length and stop issuing ``read()`` calls as soon as they've written
        that many bytes — they never make one final empty ``read()`` for a
        known-size file. Waiting for an EOF marker (as this used to) left
        ``sha256_hex`` permanently ``None`` on every real upload. A partial
        read (e.g. the connection dropped mid-upload) or an over-read (more
        bytes than expected) must not be reported as if it were the whole
        file's digest."""
        if self._over_read or not self._complete:
            return None
        return self._hasher.hexdigest()


class _CompletionPayload(aiohttp.payload.Payload):
    """Proxy an entire request payload and signal after its final write."""

    def __init__(
        self,
        value: aiohttp.payload.Payload,
        *,
        on_complete: Callable[[], None],
    ) -> None:
        super().__init__(value, headers=value.headers)
        self._size = value.size
        self._on_complete = on_complete

    async def write(self, writer) -> None:
        await self._value.write(writer)
        self._on_complete()

    def decode(self, encoding: str = "utf-8", errors: str = "strict") -> str:
        return self._value.decode(encoding, errors)


def _hash_file_sha256(path: Path, chunk_size: int = 1024 * 1024) -> str:
    """Compute a file's SHA-256 by streaming fixed-size chunks from disk, so
    memory use stays bounded to ``chunk_size`` regardless of clip length.
    Used at retry time to confirm the on-disk bytes still match what an
    earlier attempt actually uploaded."""
    hasher = hashlib.sha256()
    with path.open("rb") as fh:
        while True:
            chunk = fh.read(chunk_size)
            if not chunk:
                break
            hasher.update(chunk)
    return hasher.hexdigest()


@dataclass
class FireShareJobEnvelope:
    job_id: Optional[str]
    video_id: Optional[str]
    public_url: Optional[str]
    path: Optional[str]
    status: str
    private: Optional[bool]
    title: Optional[str]
    deduplicated: bool
    error: Optional[dict]
    created_at: Optional[str]
    updated_at: Optional[str]

    @classmethod
    def from_payload(cls, payload: dict) -> "FireShareJobEnvelope":
        return cls(
            job_id=payload.get("job_id"),
            video_id=payload.get("video_id"),
            public_url=payload.get("public_url"),
            path=payload.get("path"),
            status=str(payload.get("status") or ""),
            private=payload.get("private"),
            title=payload.get("title"),
            deduplicated=bool(payload.get("deduplicated")),
            error=payload.get("error") if isinstance(payload.get("error"), dict) else None,
            created_at=payload.get("created_at"),
            updated_at=payload.get("updated_at"),
        )


class FireShareClient:
    def __init__(self, *, base_url: str, token: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token

    def _headers(self, idempotency_key: Optional[str] = None) -> dict:
        headers = {"Authorization": f"Bearer {self.token}"}
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        return headers

    async def _json_or_error(self, response: aiohttp.ClientResponse) -> dict:
        text = await response.text()
        try:
            payload = json.loads(text) if text else {}
        except json.JSONDecodeError:
            payload = {}
        if response.status >= 400:
            error = payload.get("error") if isinstance(payload, dict) else None
            raise FireShareError(
                str((error or {}).get("code") or f"http_{response.status}"),
                str((error or {}).get("message") or f"FireShare request failed with {response.status}"),
                status=response.status,
                payload=payload if isinstance(payload, dict) else {},
                retry_after=_parse_retry_after(response.headers.get("Retry-After")),
            )
        return payload if isinstance(payload, dict) else {}

    async def upload(
        self,
        *,
        clip_path: Path,
        idempotency_key: str,
        title: str,
        folder: str,
        private: Optional[bool],
        game_id: Optional[int],
        tag_ids: list[int],
        on_progress: Callable[[int, int], None],
        on_upload_complete: Optional[Callable[[], None]] = None,
    ) -> tuple[int, FireShareJobEnvelope, int, Optional[str]]:
        timeout = aiohttp.ClientTimeout(total=60 * 30, connect=10, sock_connect=10, sock_read=60 * 5)
        url = f"{self.base_url}/api/v1/uploads"
        size = clip_path.stat().st_size
        with clip_path.open("rb") as raw:
            wrapped = _ProgressFile(raw, size, on_progress)
            form = aiohttp.FormData()
            form.add_field(
                "file",
                wrapped,
                filename=clip_path.name,
                content_type="application/octet-stream",
            )
            if title:
                form.add_field("title", title)
            if folder:
                form.add_field("folder", folder)
            if game_id is not None:
                form.add_field("game_id", str(game_id))
            if tag_ids:
                form.add_field("tag_ids", ",".join(str(i) for i in tag_ids))
            # Only send `private` when the caller made an explicit choice.
            # Omitting it lets FireShare apply its own server-side default
            # instead of us guessing one on its behalf.
            if private is not None:
                form.add_field("private", "true" if private else "false")
            request_data = form
            if isinstance(form, _AiohttpFormData):
                request_data = _CompletionPayload(
                    form(),
                    on_complete=on_upload_complete or (lambda: None),
                )
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.post(
                    url,
                    data=request_data,
                    headers=self._headers(idempotency_key),
                ) as response:
                    try:
                        payload = await self._json_or_error(response)
                    except FireShareError as exc:
                        # The multipart body (including the full clip) is
                        # streamed to the socket before headers/status come
                        # back, so even an error response still lets us
                        # record what bytes we actually sent for this
                        # immutable attempt.
                        exc.source_sha256 = wrapped.sha256_hex
                        raise
                    return (
                        response.status,
                        FireShareJobEnvelope.from_payload(payload),
                        _parse_retry_after(response.headers.get("Retry-After")),
                        wrapped.sha256_hex,
                    )

    async def get_status(self, job_id: str) -> tuple[int, FireShareJobEnvelope, int]:
        timeout = aiohttp.ClientTimeout(total=20, connect=8, sock_connect=8, sock_read=15)
        url = f"{self.base_url}/api/v1/uploads/{job_id}"
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url, headers=self._headers()) as response:
                payload = await self._json_or_error(response)
                return (
                    response.status,
                    FireShareJobEnvelope.from_payload(payload),
                    _parse_retry_after(response.headers.get("Retry-After")),
                )

    async def list_folders(self) -> dict:
        timeout = aiohttp.ClientTimeout(total=15, connect=8, sock_connect=8, sock_read=8)
        url = f"{self.base_url}/api/v1/folders"
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url, headers=self._headers()) as response:
                payload = await self._json_or_error(response)

        default_folder = payload.get("default_folder")
        folders = payload.get("folders")
        if not isinstance(default_folder, str) or not isinstance(folders, list):
            raise FireShareError(
                "invalid_response",
                "FireShare returned an invalid folder-list response",
                status=502,
            )
        try:
            normalized_default = validate_folder_name(default_folder)
            normalized_folders = [
                validate_folder_name(folder)
                for folder in folders
                if isinstance(folder, str)
            ]
        except ValueError as exc:
            raise FireShareError(
                "invalid_response",
                "FireShare returned an invalid folder-list response",
                status=502,
            ) from exc
        if (
            normalized_default != default_folder
            or len(normalized_folders) != len(folders)
            or any(normalized != original for normalized, original in zip(normalized_folders, folders))
            or len(set(normalized_folders)) != len(folders)
        ):
            raise FireShareError(
                "invalid_response",
                "FireShare returned an invalid folder-list response",
                status=502,
            )
        return {
            "default_folder": normalized_default,
            "folders": normalized_folders,
        }

    async def validate(self) -> dict:
        fake_job = "0" * 32
        timeout = aiohttp.ClientTimeout(total=15, connect=8, sock_connect=8, sock_read=8)
        url = f"{self.base_url}/api/v1/uploads/{fake_job}"
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url, headers=self._headers()) as response:
                text = await response.text()
                payload = {}
                if text:
                    try:
                        payload = json.loads(text)
                    except json.JSONDecodeError:
                        payload = {}
                if response.status in {200, 404}:
                    return {"ok": True, "status": response.status}
                error = payload.get("error") if isinstance(payload, dict) else {}
                return {
                    "ok": False,
                    "status": response.status,
                    "error_code": (error or {}).get("code") or f"http_{response.status}",
                    "error_message": (error or {}).get("message") or "FireShare validation failed",
                }


def _parse_retry_after(value: Optional[str]) -> int:
    if not value:
        return 2
    try:
        parsed = int(value)
    except ValueError:
        return 2
    return max(1, min(parsed, 120))


def _bool_or_none(value) -> Optional[bool]:
    """Normalize a nullable tri-state privacy value (SQLite INTEGER 1/0/NULL,
    or an already-Python bool/None) to a real Optional[bool]."""
    if value is None:
        return None
    return bool(value)


class _ProgressCoalescer:
    """Coalesces upload-progress callbacks that can otherwise fire once per
    (tiny) ``read()`` chunk aiohttp streams from disk — hundreds of times a
    second for a large clip — into a bounded rate of outgoing broadcasts.

    Every call to :meth:`update` records the *latest* known sent/total
    immediately (cheap, no I/O), but only ever schedules a single pending
    broadcast per attempt; a coalesced broadcast always delivers whatever
    the latest values are *at the moment it actually runs*, never a stale
    snapshot captured when it was scheduled, so intermediate ticks are
    absorbed rather than queued up as separate broadcasts/tasks.
    """

    #: Minimum spacing between two progress broadcasts for the same
    #: attempt. Bounds broadcast/task volume regardless of how fast the
    #: underlying file streams, while still updating a few times a second.
    MIN_INTERVAL = 0.2

    def __init__(
        self,
        loop: asyncio.AbstractEventLoop,
        emit: Callable[[int, int], Awaitable[None]],
    ) -> None:
        self._loop = loop
        self._emit = emit
        self._latest: Optional[tuple[int, int]] = None
        self._last_emit_at = float("-inf")
        self._pending: Optional[asyncio.Task] = None
        self._closed = False

    def update(self, sent: int, total: int) -> None:
        """Record the newest progress. Must be called on the event-loop
        thread (e.g. via ``loop.call_soon_threadsafe``); never performs I/O
        itself and never spawns more than one pending task at a time."""
        if self._closed:
            return
        self._latest = (sent, total)
        if self._pending is not None and not self._pending.done():
            return
        delay = max(0.0, self.MIN_INTERVAL - (self._loop.time() - self._last_emit_at))
        self._pending = asyncio.create_task(self._fire_after(delay))

    async def _fire_after(self, delay: float) -> None:
        if delay:
            await asyncio.sleep(delay)
        if self._closed or self._latest is None:
            return
        sent, total = self._latest
        self._last_emit_at = self._loop.time()
        await self._emit(sent, total)

    async def _cancel_pending(self) -> None:
        pending, self._pending = self._pending, None
        if pending is not None and not pending.done():
            pending.cancel()
            try:
                await pending
            except asyncio.CancelledError:
                pass

    async def flush(self) -> None:
        """Force-emit whatever progress is currently the latest known value
        (bypassing the throttle window) and then stop accepting/emitting
        anything further. Used to guarantee the true final tick — which may
        still be sitting inside a throttle window rather than already
        broadcast — is delivered *before* the caller moves the attempt on to
        its next (processing/terminal) state, so the UI never sees the
        processing/ready transition arrive ahead of a 100% progress tick."""
        self._closed = True
        await self._cancel_pending()
        if self._latest is not None:
            sent, total = self._latest
            self._last_emit_at = self._loop.time()
            await self._emit(sent, total)

    async def close(self) -> None:
        """Stop accepting/emitting further progress without a final emit —
        used on cancellation/error, where no further progress tick for this
        attempt should ever reach the UI."""
        self._closed = True
        await self._cancel_pending()


class FireSharePublishManager:
    def __init__(
        self,
        *,
        library: ClipLibrary,
        broadcast: Callable[[dict], Awaitable[None]],
        resolve_clip: Callable[[str], Optional[dict]],
        resolve_clip_by_uuid: Callable[[str], Optional[dict]],
    ) -> None:
        self._library = library
        self._broadcast = broadcast
        self._resolve_clip = resolve_clip
        self._resolve_clip_by_uuid = resolve_clip_by_uuid
        self._tasks: dict[str, asyncio.Task] = {}
        self._states: dict[str, dict] = {}
        self._canceled: set[str] = set()
        # Monotonic per-attempt broadcast sequence numbers. Attached to
        # every fireshare_publish_* broadcast so the UI can detect and drop
        # a stale/out-of-order delivery (e.g. a throttled progress tick that
        # was still in flight when a terminal state arrived) instead of
        # letting it regress an already-newer displayed state.
        self._event_seq: dict[str, int] = {}
        self._upload_complete: dict[str, asyncio.Event] = {}

    def _next_seq(self, attempt_id: str) -> int:
        seq = self._event_seq.get(attempt_id, 0) + 1
        self._event_seq[attempt_id] = seq
        return seq

    def is_active_slug(self, slug: str) -> bool:
        return any(
            state.get("slug") == slug and not task.done()
            for attempt_id, task in self._tasks.items()
            if (state := self._states.get(attempt_id))
        )

    def status(self) -> list[dict]:
        return [
            dict(state)
            for attempt_id, task in self._tasks.items()
            if not task.done() and (state := self._states.get(attempt_id))
        ]

    def _attempt_to_state(self, attempt: dict) -> dict:
        return {
            "attempt_id": attempt.get("attempt_id"),
            "clip_uuid": attempt.get("clip_uuid"),
            "state": attempt.get("state"),
            "job_id": attempt.get("job_id"),
            "video_id": attempt.get("video_id"),
            "public_url": attempt.get("public_url"),
            "remote_status": attempt.get("remote_status"),
            "error_code": attempt.get("error_code"),
            "error_message": attempt.get("error_message"),
            "folder": attempt.get("folder"),
            "updated_at": attempt.get("updated_at"),
            **self._privacy_fields(attempt),
        }

    @staticmethod
    def _privacy_fields(attempt: dict) -> dict:
        """The nullable *requested* privacy (what we asked for, `None` meaning
        "FireShare's default") kept distinct from the nullable *effective*
        privacy (what FireShare actually applied, `None` until it responds)."""
        return {
            "requested_private": _bool_or_none(attempt.get("private")),
            "effective_private": _bool_or_none(attempt.get("effective_private")),
        }

    def get_clip_publication(self, clip_uuid: str) -> dict:
        pub = self._library.get_fireshare_current(clip_uuid)
        attempts = self._library.list_fireshare_attempts(clip_uuid, limit=10)
        for attempt in attempts:
            attempt.update(self._privacy_fields(attempt))
        for key in ("current", "last_ready"):
            row = pub.get(key)
            if row:
                row.update(self._privacy_fields(row))
        current = pub.get("current")
        if current:
            live = self._states.get(str(current.get("attempt_id") or ""))
            if live:
                current.update(live)
        return {
            "current": pub["current"],
            "last_ready": pub["last_ready"],
            "history": attempts,
        }

    async def publish(
        self,
        *,
        slug: str,
        base_url: str,
        token: str,
        options: dict,
    ) -> dict:
        clip = self._resolve_clip(slug)
        if not clip:
            raise FireShareError("clip_not_found", "Clip no longer exists locally", status=404)
        clip_uuid = str(clip.get("uuid") or "")
        if not clip_uuid:
            raise FireShareError("clip_identity_missing", "Clip identity is unavailable", status=409)
        if self.is_active_slug(slug):
            raise FireShareError(
                "publish_in_progress",
                "This clip is already publishing to FireShare.",
                status=409,
            )

        private = options.get("private")
        if private is not None and not isinstance(private, bool):
            raise FireShareError("invalid_private", "Private must be true, false, or omitted/null", status=400)

        return self.start_publish(
            slug=slug,
            clip_path=Path(clip["path"]),
            clip_uuid=clip_uuid,
            game=str(clip.get("game") or ""),
            base_url=base_url,
            token=token,
            title=str(options.get("title") or "").strip(),
            folder=str(options.get("folder") or "").strip(),
            private=private,
            game_id=_parse_optional_id(options.get("game_id"), "game_id"),
            tag_ids=_parse_id_list(options.get("tag_ids"), "tag_ids"),
        )

    def start_publish(
        self,
        *,
        slug: str,
        clip_path: Path,
        clip_uuid: str,
        game: str,
        base_url: str,
        token: str,
        title: str,
        folder: str,
        private: Optional[bool],
        game_id: Optional[int],
        tag_ids: list[int],
    ) -> dict:
        ext = clip_path.suffix.lower()
        if ext not in ALLOWED_EXTENSIONS:
            raise FireShareError(
                "unsupported_file_type",
                "FireShare only supports .mp4, .m4v, .mov, and .webm",
                status=415,
            )
        st = clip_path.stat()
        attempt_id = uuid.uuid4().hex
        attempt = {
            "attempt_id": attempt_id,
            "clip_uuid": clip_uuid,
            "idempotency_key": attempt_id,
            "source_device": getattr(st, "st_dev", None),
            "source_inode": getattr(st, "st_ino", None),
            "source_size": st.st_size,
            "source_mtime_ns": st.st_mtime_ns,
            # Filled in once the upload actually streams the file (see
            # _merge_remote_envelope / _set_failed); this cheap stat
            # snapshot is what gates the initial "is this attempt still
            # fresh?" UI check, not the (comparatively expensive) hash.
            "source_sha256": None,
            "title": title,
            "folder": folder,
            "private": None if private is None else (1 if private else 0),
            "effective_private": None,
            "game_id": game_id,
            "tag_ids_json": json.dumps(tag_ids, separators=(",", ":")),
            "job_id": None,
            "video_id": None,
            "public_url": None,
            "remote_path": None,
            "remote_status": None,
            "deduplicated": 0,
            "state": "uploading",
            "error_code": None,
            "error_message": None,
            "http_status": None,
            "created_at": _now(),
            "updated_at": _now(),
            "started_at": _now(),
            "finished_at": None,
            "last_polled_at": None,
            "next_poll_at": None,
        }
        self._library.save_fireshare_attempt(attempt)
        self._library.set_fireshare_current(clip_uuid, current_attempt_id=attempt_id)
        self._states[attempt_id] = {
            "attempt_id": attempt_id,
            "clip_uuid": clip_uuid,
            "slug": slug,
            "state": "uploading",
            "cancelable": st.st_size > 0,
            "sent_bytes": 0,
            "total_bytes": st.st_size,
            "progress_pct": 0.0,
            "started_at": _now(),
        }
        upload_complete = asyncio.Event()
        if st.st_size == 0:
            upload_complete.set()
        self._upload_complete[attempt_id] = upload_complete
        task = asyncio.create_task(
            self._run_publish(
                attempt_id=attempt_id,
                slug=slug,
                clip_path=clip_path,
                clip_uuid=clip_uuid,
                game=game,
                base_url=base_url,
                token=token,
                title=title,
                folder=folder,
                private=private,
                game_id=game_id,
                tag_ids=tag_ids,
            )
        )
        self._tasks[attempt_id] = task
        result = self._attempt_to_state(
            self._library.get_fireshare_attempt(attempt_id) or attempt
        )
        result["cancelable"] = st.st_size > 0
        return result

    async def _run_publish(
        self,
        *,
        attempt_id: str,
        slug: str,
        clip_path: Path,
        clip_uuid: str,
        game: str,
        base_url: str,
        token: str,
        title: str,
        folder: str,
        private: Optional[bool],
        game_id: Optional[int],
        tag_ids: list[int],
    ) -> None:
        client = FireShareClient(base_url=base_url, token=token)
        loop = asyncio.get_running_loop()
        upload_complete = self._upload_complete[attempt_id]

        async def emit_progress(sent: int, total: int) -> None:
            progress = (float(sent) / float(total)) if total else 0.0
            state = self._states.get(attempt_id)
            if (
                state is None
                or state.get("state") != "uploading"
                or attempt_id in self._canceled
            ):
                return
            cancelable = not upload_complete.is_set()
            state.update(
                {
                    "cancelable": cancelable,
                    "sent_bytes": sent,
                    "total_bytes": total,
                    "progress_pct": progress * 100.0,
                }
            )
            await self._broadcast(
                {
                    "type": "fireshare_publish_progress",
                    "attempt_id": attempt_id,
                    "slug": slug,
                    "sent_bytes": sent,
                    "total_bytes": total,
                    "progress": progress,
                    "progress_pct": progress * 100.0,
                    "cancelable": cancelable,
                    "seq": self._next_seq(attempt_id),
                }
            )

        # aiohttp issues one synchronous read() per (small) chunk from a
        # worker thread; without coalescing that means one asyncio task and
        # one WS broadcast per chunk (hundreds/sec for a large clip). The
        # coalescer absorbs that burst into a bounded-rate, latest-value-wins
        # stream of broadcasts instead.
        progress_coalescer = _ProgressCoalescer(loop, emit_progress)

        def on_progress(sent: int, total: int) -> None:
            loop.call_soon_threadsafe(progress_coalescer.update, sent, total)

        def on_upload_complete() -> None:
            upload_complete.set()
            state = self._states.get(attempt_id)
            if (
                state is None
                or state.get("state") != "uploading"
                or attempt_id in self._canceled
            ):
                return
            state["cancelable"] = False

        try:
            await self._broadcast(
                {
                    "type": "fireshare_publish_started",
                    "attempt_id": attempt_id,
                    "slug": slug,
                    "seq": self._next_seq(attempt_id),
                }
            )
            status_code, envelope, retry_after, source_sha256 = await client.upload(
                clip_path=clip_path,
                idempotency_key=attempt_id,
                title=title,
                folder=folder,
                private=private,
                game_id=game_id,
                tag_ids=tag_ids,
                on_progress=on_progress,
                on_upload_complete=on_upload_complete,
            )
            on_upload_complete()
            # Guarantee the true final (100%) tick — which may still be
            # sitting inside the coalescer's throttle window rather than
            # already broadcast — lands *before* the processing/ready
            # envelope transition below, then stop accepting any further
            # progress for this attempt.
            await progress_coalescer.flush()
            await self._merge_remote_envelope(
                attempt_id,
                slug,
                clip_uuid,
                status_code=status_code,
                envelope=envelope,
                retry_after=retry_after,
                source_sha256=source_sha256,
            )
            if envelope.status in {"accepted", "processing"} and envelope.job_id:
                await self._poll_until_terminal(
                    attempt_id=attempt_id,
                    slug=slug,
                    clip_uuid=clip_uuid,
                    base_url=base_url,
                    token=token,
                    job_id=envelope.job_id,
                    delay=retry_after,
                )
        except asyncio.CancelledError:
            # No upload tick may arrive after the canceled state: stop and
            # flush/cancel any progress broadcast still pending first.
            await progress_coalescer.close()
            if attempt_id in self._canceled:
                await self._set_failed(
                    attempt_id,
                    slug,
                    code="canceled",
                    message="FireShare publish canceled",
                    state="canceled",
                )
            raise
        except FireShareError as exc:
            await progress_coalescer.close()
            state = "retryable_ambiguous" if exc.status is None else "failed"
            await self._set_failed(
                attempt_id,
                slug,
                code=exc.code,
                message=exc.message,
                state=state,
                http_status=exc.status,
                source_sha256=exc.source_sha256,
            )
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as exc:
            await progress_coalescer.close()
            await self._set_failed(
                attempt_id,
                slug,
                code="network_error",
                message=str(exc) or "Network error while publishing to FireShare",
                state="retryable_ambiguous",
            )
        finally:
            await progress_coalescer.close()
            self._tasks.pop(attempt_id, None)
            self._upload_complete.pop(attempt_id, None)
            state = self._library.get_fireshare_attempt(attempt_id)
            if state:
                self._states[attempt_id] = self._attempt_to_state(state)

    async def _poll_until_terminal(
        self,
        *,
        attempt_id: str,
        slug: str,
        clip_uuid: str,
        base_url: str,
        token: str,
        job_id: str,
        delay: int,
    ) -> None:
        client = FireShareClient(base_url=base_url, token=token)
        wait_seconds = max(1, delay)
        while True:
            if attempt_id in self._canceled:
                return
            await asyncio.sleep(wait_seconds)
            try:
                status_code, envelope, retry_after = await client.get_status(job_id)
            except FireShareError as exc:
                await self._set_failed(
                    attempt_id,
                    slug,
                    code=exc.code,
                    message=exc.message,
                    http_status=exc.status,
                )
                return
            await self._merge_remote_envelope(
                attempt_id,
                slug,
                clip_uuid,
                status_code=status_code,
                envelope=envelope,
                retry_after=retry_after,
                polled=True,
            )
            if envelope.status in {"ready", "failed"}:
                return
            wait_seconds = retry_after

    async def _merge_remote_envelope(
        self,
        attempt_id: str,
        slug: str,
        clip_uuid: str,
        *,
        status_code: int,
        envelope: FireShareJobEnvelope,
        retry_after: int,
        polled: bool = False,
        source_sha256: Optional[str] = None,
    ) -> None:
        state = "processing"
        if envelope.status == "ready":
            state = "ready"
        elif envelope.status == "failed":
            state = "failed"
        elif envelope.status in {"accepted", "processing"}:
            state = "processing"
        payload = self._library.get_fireshare_attempt(attempt_id) or {}
        payload.update(
            {
                "attempt_id": attempt_id,
                "clip_uuid": clip_uuid,
                "job_id": envelope.job_id,
                "video_id": envelope.video_id,
                "public_url": envelope.public_url,
                "remote_path": envelope.path,
                "remote_status": envelope.status,
                "deduplicated": 1 if envelope.deduplicated else 0,
                "state": state,
                # FireShare's effective privacy for this attempt, distinct from
                # what we requested. Only overwrite when this response actually
                # carries it; a poll that omits the field shouldn't erase a
                # value learned from an earlier response.
                "effective_private": (
                    (1 if envelope.private else 0)
                    if envelope.private is not None
                    else payload.get("effective_private")
                ),
                # The immutable attempt's source hash is set exactly once,
                # the first time the upload actually streamed the file (a
                # later poll response never carries one and must not erase
                # it; a retry that re-uploads the *same* bytes would compute
                # the same digest anyway).
                "source_sha256": payload.get("source_sha256") or source_sha256,
                "error_code": (envelope.error or {}).get("code"),
                "error_message": (envelope.error or {}).get("message"),
                "http_status": status_code,
                "updated_at": _now(),
                "last_polled_at": _now() if polled else payload.get("last_polled_at"),
                "next_poll_at": _now(),
                "finished_at": _now() if state in {"ready", "failed"} else None,
            }
        )
        self._library.save_fireshare_attempt(payload)
        if state == "ready":
            self._library.set_fireshare_current(
                clip_uuid,
                current_attempt_id=attempt_id,
                last_ready_attempt_id=attempt_id,
            )
        else:
            self._library.set_fireshare_current(
                clip_uuid,
                current_attempt_id=attempt_id,
            )
        self._states[attempt_id] = self._attempt_to_state(payload)
        event = {
            "ready": "fireshare_publish_ready",
            "failed": "fireshare_publish_failed",
        }.get(state, "fireshare_publish_processing")
        await self._broadcast(
            {
                "type": event,
                "attempt_id": attempt_id,
                "slug": slug,
                "state": state,
                "remote_status": envelope.status,
                "job_id": envelope.job_id,
                "video_id": envelope.video_id,
                "public_url": envelope.public_url,
                "error": envelope.error,
                "error_code": (envelope.error or {}).get("code"),
                "error_message": (envelope.error or {}).get("message"),
                "deduplicated": envelope.deduplicated,
                "seq": self._next_seq(attempt_id),
                **self._privacy_fields(payload),
            }
        )

    async def _set_failed(
        self,
        attempt_id: str,
        slug: str,
        *,
        code: str,
        message: str,
        state: str = "failed",
        http_status: Optional[int] = None,
        source_sha256: Optional[str] = None,
    ) -> None:
        payload = self._library.get_fireshare_attempt(attempt_id)
        if not payload:
            return
        payload.update(
            {
                "state": state,
                "error_code": code,
                "error_message": message,
                "http_status": http_status,
                "updated_at": _now(),
                "finished_at": _now(),
                # Even a failed request still ran the full multipart body
                # through disk once the socket write completed; keep that
                # digest so a later retry can detect the file changing
                # underneath a "retryable" attempt.
                "source_sha256": payload.get("source_sha256") or source_sha256,
            }
        )
        self._library.save_fireshare_attempt(payload)
        self._states[attempt_id] = self._attempt_to_state(payload)
        await self._broadcast(
            {
                "type": "fireshare_publish_failed",
                "attempt_id": attempt_id,
                "slug": slug,
                "state": state,
                "error": {"code": code, "message": message},
                "error_code": code,
                "error_message": message,
                "http_status": http_status,
                "seq": self._next_seq(attempt_id),
            }
        )

    async def cancel(self, attempt_id: str) -> dict:
        attempt = self._library.get_fireshare_attempt(attempt_id)
        if not attempt:
            raise FireShareError(
                "not_found",
                "FireShare publish attempt not found.",
                status=404,
            )

        state = str(attempt.get("state") or "")
        seq = self._event_seq.get(attempt_id)
        if state != "uploading":
            raise FireShareError(
                "attempt_not_cancelable",
                "This FireShare upload can no longer be canceled because it is "
                f"{state or 'no longer uploading'}.",
                status=409,
                payload={"state": state or None, "seq": seq},
            )
        if attempt_id in self._canceled:
            raise FireShareError(
                "cancellation_in_progress",
                "Cancellation is already in progress for this FireShare upload.",
                status=409,
                payload={"state": state, "seq": seq},
            )

        task = self._tasks.get(attempt_id)
        if not task or task.done():
            latest = self._library.get_fireshare_attempt(attempt_id) or attempt
            latest_state = str(latest.get("state") or "")
            raise FireShareError(
                "attempt_not_active",
                "This FireShare upload is no longer active. Refresh its status before trying again.",
                status=409,
                payload={
                    "state": latest_state or None,
                    "cancelable": False,
                    "seq": self._event_seq.get(attempt_id),
                },
            )
        upload_complete = self._upload_complete.get(attempt_id)
        if not upload_complete or upload_complete.is_set():
            raise FireShareError(
                "upload_already_sent",
                "The upload request has already finished sending. FireShare does not "
                "support canceling while it accepts or processes the upload.",
                status=409,
                payload={"state": state, "cancelable": False, "seq": seq},
            )

        self._canceled.add(attempt_id)
        try:
            if not task.cancel():
                latest = self._library.get_fireshare_attempt(attempt_id) or attempt
                raise FireShareError(
                    "attempt_not_active",
                    "This FireShare upload finished before cancellation could take effect.",
                    status=409,
                    payload={
                        "state": latest.get("state"),
                        "seq": self._event_seq.get(attempt_id),
                    },
                )
            try:
                await task
            except asyncio.CancelledError:
                pass

            canceled = self._library.get_fireshare_attempt(attempt_id)
            if canceled and canceled.get("state") == "uploading":
                slug = str((self._states.get(attempt_id) or {}).get("slug") or "")
                await self._set_failed(
                    attempt_id,
                    slug,
                    code="canceled",
                    message="FireShare publish canceled",
                    state="canceled",
                )
                canceled = self._library.get_fireshare_attempt(attempt_id)
            if not canceled or canceled.get("state") != "canceled":
                latest_state = (canceled or attempt).get("state")
                raise FireShareError(
                    "cancel_not_confirmed",
                    "The FireShare upload finished before cancellation could be confirmed.",
                    status=409,
                    payload={
                        "state": latest_state,
                        "seq": self._event_seq.get(attempt_id),
                    },
                )
            return self._attempt_to_state(canceled)
        finally:
            self._canceled.discard(attempt_id)
            if task.done():
                self._tasks.pop(attempt_id, None)
                self._upload_complete.pop(attempt_id, None)

    async def retry(
        self,
        *,
        attempt_id: str,
        base_url: str,
        token: str,
    ) -> dict:
        attempt = self._library.get_fireshare_attempt(attempt_id)
        if not attempt:
            raise FireShareError("not_found", "Publish attempt not found", status=404)
        if attempt.get("state") not in {"failed", "retryable_ambiguous", "canceled"}:
            raise FireShareError(
                "attempt_not_retryable",
                "Only failed or canceled FireShare attempts can be retried.",
                status=409,
            )
        clip_uuid = attempt.get("clip_uuid")
        if not clip_uuid:
            raise FireShareError("not_found", "Clip identity is missing for this attempt", status=404)
        clip_info = self._resolve_clip_by_uuid(clip_uuid)
        if not clip_info:
            raise FireShareError("clip_not_found", "Clip no longer exists locally", status=404)
        existing_task = self._tasks.get(attempt_id)
        if existing_task and not existing_task.done():
            raise FireShareError("publish_in_progress", "This publish attempt is already active", status=409)

        clip_path = Path(clip_info["path"])
        st = clip_path.stat()
        snapshot = (
            int(attempt.get("source_size") or 0),
            int(attempt.get("source_mtime_ns") or 0),
            int(attempt.get("source_device") or 0),
            int(attempt.get("source_inode") or 0),
        )
        current = (
            int(st.st_size),
            int(st.st_mtime_ns),
            int(getattr(st, "st_dev", 0)),
            int(getattr(st, "st_ino", 0)),
        )
        if snapshot != current:
            raise FireShareError(
                "source_changed",
                "The local clip changed after this attempt. Use Republish to create a new snapshot.",
                status=409,
            )

        # The stat snapshot above is a cheap, non-blocking guard (size,
        # mtime, device, inode) — good enough for the common case, but a
        # file can be rewritten with its original size and a forced/clock-
        # skewed mtime restored. When we recorded a full SHA-256 for the
        # original upload, re-hash the current bytes (bounded-memory,
        # streamed off the event loop) and refuse to reuse the same
        # idempotency key on a mismatch. Legacy attempts with no stored
        # hash (pre-upgrade data) fall back to the stat-only check above,
        # exactly as before.
        stored_sha256 = attempt.get("source_sha256")
        if stored_sha256:
            current_sha256 = await asyncio.to_thread(_hash_file_sha256, clip_path)
            if current_sha256 != stored_sha256:
                raise FireShareError(
                    "source_changed",
                    "The local clip's contents changed after this attempt, even though its size "
                    "and modified time matched. Use Republish to create a new snapshot.",
                    status=409,
                )

        attempt.update(
            {
                "state": "uploading",
                "error_code": None,
                "error_message": None,
                "http_status": None,
                "updated_at": _now(),
                "started_at": _now(),
                "finished_at": None,
                # A retry is a brand-new network attempt at the *same*
                # requested privacy (left untouched above); any effective
                # privacy learned from a prior half-finished attempt is now
                # stale and must not be shown until this attempt responds.
                "effective_private": None,
            }
        )
        self._library.save_fireshare_attempt(attempt)
        self._library.set_fireshare_current(clip_uuid, current_attempt_id=attempt_id)
        self._canceled.discard(attempt_id)
        self._states[attempt_id] = {
            "attempt_id": attempt_id,
            "clip_uuid": clip_uuid,
            "slug": clip_info["slug"],
            "state": "uploading",
            "cancelable": st.st_size > 0,
            "sent_bytes": 0,
            "total_bytes": st.st_size,
            "progress_pct": 0.0,
            "started_at": attempt["started_at"],
        }
        upload_complete = asyncio.Event()
        if st.st_size == 0:
            upload_complete.set()
        self._upload_complete[attempt_id] = upload_complete
        self._tasks[attempt_id] = asyncio.create_task(
            self._run_publish(
                attempt_id=attempt_id,
                slug=clip_info["slug"],
                clip_path=clip_path,
                clip_uuid=clip_uuid,
                game=str(clip_info.get("game") or ""),
                base_url=base_url,
                token=token,
                title=str(attempt.get("title") or ""),
                folder=str(attempt.get("folder") or ""),
                private=_bool_or_none(attempt.get("private")),
                game_id=attempt.get("game_id"),
                tag_ids=_parse_tag_ids(attempt.get("tag_ids_json")),
            )
        )
        state = self._attempt_to_state(attempt)
        state["cancelable"] = st.st_size > 0
        return state

    async def resume_nonterminal(self, *, base_url: str, token: str) -> None:
        attempts = self._library.list_nonterminal_fireshare_attempts()
        for attempt in attempts:
            if attempt.get("state") == "uploading" and not attempt.get("job_id"):
                attempt["state"] = "retryable_ambiguous"
                attempt["error_code"] = "resume_required"
                attempt["error_message"] = "Vice restarted before FireShare acceptance was confirmed."
                attempt["updated_at"] = _now()
                self._library.save_fireshare_attempt(attempt)
                continue
            job_id = attempt.get("job_id")
            clip = self._resolve_clip_by_uuid(attempt.get("clip_uuid") or "")
            if not job_id or not clip:
                continue
            aid = str(attempt.get("attempt_id"))
            if aid in self._tasks:
                continue
            self._states[aid] = self._attempt_to_state(attempt)
            self._tasks[aid] = asyncio.create_task(
                self._poll_until_terminal(
                    attempt_id=aid,
                    slug=clip["slug"],
                    clip_uuid=clip["uuid"],
                    base_url=base_url,
                    token=token,
                    job_id=job_id,
                    delay=2,
                )
            )

    async def shutdown(self) -> None:
        tasks = list(self._tasks.values())
        for task in tasks:
            task.cancel()
        for task in tasks:
            try:
                await task
            except asyncio.CancelledError:
                pass
        self._tasks.clear()


def _parse_tag_ids(raw: Optional[str]) -> list[int]:
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, list):
        return []
    out: list[int] = []
    for item in parsed:
        try:
            out.append(int(item))
        except (TypeError, ValueError):
            continue
    return out


def _parse_optional_id(raw, name: str) -> Optional[int]:
    if raw in (None, ""):
        return None
    if isinstance(raw, bool):
        raise FireShareError(f"invalid_{name}", f"{name} must be a positive integer", status=400)
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise FireShareError(f"invalid_{name}", f"{name} must be a positive integer", status=400) from None
    if value <= 0:
        raise FireShareError(f"invalid_{name}", f"{name} must be a positive integer", status=400)
    return value


def _parse_id_list(raw, name: str) -> list[int]:
    if raw in (None, ""):
        return []
    if not isinstance(raw, list):
        raise FireShareError(f"invalid_{name}", f"{name} must be a list", status=400)
    values: list[int] = []
    for item in raw:
        value = _parse_optional_id(item, name)
        if value is None:
            raise FireShareError(
                f"invalid_{name}",
                f"{name} entries must be positive integers",
                status=400,
            )
        values.append(value)
    return values
