from __future__ import annotations

import asyncio
import io
import json
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Awaitable, Callable, Optional
from urllib.parse import urlparse

import aiohttp

from .library import ClipLibrary

ALLOWED_EXTENSIONS = {".mp4", ".m4v", ".mov", ".webm"}


class FireShareError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        status: Optional[int] = None,
        payload: Optional[dict] = None,
        retry_after: Optional[int] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.payload = payload or {}
        self.retry_after = retry_after


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


class _ProgressFile(io.BufferedReader):
    def __init__(self, raw, total: int, on_progress: Callable[[int, int], None]) -> None:
        super().__init__(raw)
        self._total = max(0, int(total))
        self._sent = 0
        self._on_progress = on_progress

    def read(self, size: int = -1):  # type: ignore[override]
        chunk = super().read(size)
        if chunk:
            self._sent += len(chunk)
            self._on_progress(self._sent, self._total)
        return chunk


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
        private: bool,
        game_id: Optional[int],
        tag_ids: list[int],
        on_progress: Callable[[int, int], None],
    ) -> tuple[int, FireShareJobEnvelope, int]:
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
            form.add_field("private", "true" if private else "false")
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.post(
                    url,
                    data=form,
                    headers=self._headers(idempotency_key),
                ) as response:
                    payload = await self._json_or_error(response)
                    return (
                        response.status,
                        FireShareJobEnvelope.from_payload(payload),
                        _parse_retry_after(response.headers.get("Retry-After")),
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
            "updated_at": attempt.get("updated_at"),
        }

    def get_clip_publication(self, clip_uuid: str) -> dict:
        current = self._library.get_fireshare_current(clip_uuid)
        attempts = self._library.list_fireshare_attempts(clip_uuid, limit=10)
        return {
            "current": current["current"],
            "last_ready": current["last_ready"],
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

        private = options.get("private", False)
        if not isinstance(private, bool):
            raise FireShareError("invalid_private", "Private must be true or false", status=400)

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
        private: bool,
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
            "source_sha256": None,
            "title": title,
            "folder": folder,
            "private": 1 if private else 0,
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
            "sent_bytes": 0,
            "total_bytes": st.st_size,
            "progress_pct": 0.0,
            "started_at": _now(),
        }
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
        return self._attempt_to_state(self._library.get_fireshare_attempt(attempt_id) or attempt)

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
        private: bool,
        game_id: Optional[int],
        tag_ids: list[int],
    ) -> None:
        await self._broadcast({"type": "fireshare_publish_started", "attempt_id": attempt_id, "slug": slug})
        client = FireShareClient(base_url=base_url, token=token)
        loop = asyncio.get_running_loop()

        def emit_progress(sent: int, total: int, progress: float) -> None:
            state = self._states.get(attempt_id)
            if state is not None:
                state.update(
                    {
                        "sent_bytes": sent,
                        "total_bytes": total,
                        "progress_pct": progress * 100.0,
                    }
                )
            asyncio.create_task(
                self._broadcast(
                    {
                        "type": "fireshare_publish_progress",
                        "attempt_id": attempt_id,
                        "slug": slug,
                        "sent_bytes": sent,
                        "total_bytes": total,
                        "progress": progress,
                        "progress_pct": progress * 100.0,
                    }
                )
            )

        def on_progress(sent: int, total: int) -> None:
            progress = (float(sent) / float(total)) if total else 0.0
            loop.call_soon_threadsafe(emit_progress, sent, total, progress)

        try:
            status_code, envelope, retry_after = await client.upload(
                clip_path=clip_path,
                idempotency_key=attempt_id,
                title=title,
                folder=folder,
                private=private,
                game_id=game_id,
                tag_ids=tag_ids,
                on_progress=on_progress,
            )
            await self._merge_remote_envelope(
                attempt_id,
                slug,
                clip_uuid,
                status_code=status_code,
                envelope=envelope,
                retry_after=retry_after,
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
            self._canceled.add(attempt_id)
            await self._set_failed(
                attempt_id,
                slug,
                code="canceled",
                message="FireShare publish canceled",
                state="canceled",
            )
            raise
        except FireShareError as exc:
            state = "retryable_ambiguous" if exc.status is None else "failed"
            await self._set_failed(
                attempt_id,
                slug,
                code=exc.code,
                message=exc.message,
                state=state,
                http_status=exc.status,
            )
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as exc:
            await self._set_failed(
                attempt_id,
                slug,
                code="network_error",
                message=str(exc) or "Network error while publishing to FireShare",
                state="retryable_ambiguous",
            )
        finally:
            self._tasks.pop(attempt_id, None)
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
            }
        )

    async def cancel(self, attempt_id: str) -> bool:
        task = self._tasks.get(attempt_id)
        if not task:
            return False
        self._canceled.add(attempt_id)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        return True

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

        attempt.update(
            {
                "state": "uploading",
                "error_code": None,
                "error_message": None,
                "http_status": None,
                "updated_at": _now(),
                "started_at": _now(),
                "finished_at": None,
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
            "sent_bytes": 0,
            "total_bytes": st.st_size,
            "progress_pct": 0.0,
            "started_at": attempt["started_at"],
        }
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
                private=bool(attempt.get("private")),
                game_id=attempt.get("game_id"),
                tag_ids=_parse_tag_ids(attempt.get("tag_ids_json")),
            )
        )
        return self._attempt_to_state(attempt)

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
