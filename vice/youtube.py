"""YouTube uploads through the optional porjo/youtubeuploader CLI."""

from __future__ import annotations

import asyncio
import os
import re
import shutil
import time
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Awaitable, Callable, Optional

from .config import YouTubeConnector, YOUTUBE_PRIVACY_VALUES
from .runtime import actual_home_dir, resolve_path

VIDEO_ID_RE = re.compile(r"Video ID:\s*([A-Za-z0-9_-]{11})")
PLAYLIST_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,128}")
OUTPUT_TAIL_BYTES = 16 * 1024


class YouTubeUploadBusy(Exception):
    pass


@dataclass(frozen=True)
class YouTubeUploadSpec:
    title: str
    description: str
    privacy: str
    tags: list[str]
    playlist_ids: list[str]
    notify: bool


def _config_path(value: str) -> Path:
    path = resolve_path(value)
    if not path.is_absolute():
        path = actual_home_dir() / path
    return path


def resolve_uploader_executable(value: str) -> Optional[str]:
    """Resolve a command name through PATH or a configured filesystem path."""
    raw = str(value or "youtubeuploader").strip()
    if not raw or "\0" in raw:
        return None
    if "/" in raw or "\\" in raw or raw.startswith(("~", ".")):
        path = _config_path(raw)
        if path.is_file() and os.access(path, os.X_OK):
            return str(path)
        return None
    return shutil.which(raw)


def connector_preflight(executable: str, connector: YouTubeConnector) -> dict:
    resolved = resolve_uploader_executable(executable)
    payload = {
        "id": connector.id,
        "name": connector.name,
        "available": bool(resolved),
        "executable": resolved,
        "auth_required": False,
        "error": None,
    }
    if not resolved:
        payload["error"] = (
            f'{executable or "youtubeuploader"} was not found. Install it or '
            "set its full path in YouTube settings."
        )
        return payload

    if connector.secrets_path:
        secrets = _config_path(connector.secrets_path)
        if not secrets.is_file():
            payload["available"] = False
            payload["error"] = f"OAuth client secrets file not found: {secrets}"
            return payload
    if connector.cache_path:
        cache = _config_path(connector.cache_path)
        if not cache.is_file():
            payload["available"] = False
            payload["auth_required"] = True
            payload["error"] = (
                f"OAuth token cache not found: {cache}. Authenticate this "
                "connector once with youtubeuploader from a terminal."
            )
    return payload


def parse_video_id(output: str) -> Optional[str]:
    matches = VIDEO_ID_RE.findall(output or "")
    return matches[-1] if matches else None


def _string_list(raw, field_name: str) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, str):
        values = re.split(r"[,\n]", raw)
    elif isinstance(raw, list):
        values = raw
    else:
        raise ValueError(f"{field_name} must be a list")
    return [str(value).strip() for value in values if str(value).strip()]


def _render_title(template: str, clip_path: Path, game: str, now: datetime) -> str:
    title = (template or "$filename")
    title = (
        title.replace("$filename", clip_path.stem)
        .replace("$game", game or "")
        .replace("$date", now.strftime("%Y-%m-%d"))
        .replace("$time", now.strftime("%H%M"))
    )
    title = re.sub(r"[\r\n]+", " ", title).strip()
    if not title:
        raise ValueError("YouTube title cannot be empty")
    if len(title) > 100:
        raise ValueError("YouTube title must be 100 characters or fewer")
    return title


def build_upload_spec(
    connector: YouTubeConnector,
    clip_path: Path,
    *,
    game: str = "",
    overrides: Optional[dict] = None,
    now: Optional[datetime] = None,
) -> YouTubeUploadSpec:
    values = overrides or {}
    title_source = (
        str(values["title"]) if "title" in values
        else connector.title_template
    )
    title = _render_title(title_source, clip_path, game, now or datetime.now())

    description = (
        str(values["description"]) if "description" in values
        else connector.description
    )
    if len(description) > 5000:
        raise ValueError("YouTube description must be 5000 characters or fewer")

    privacy = str(values.get("privacy", connector.privacy)).strip().lower()
    if privacy not in YOUTUBE_PRIVACY_VALUES:
        raise ValueError("YouTube privacy must be private, unlisted, or public")

    tags = _string_list(values.get("tags", connector.tags), "YouTube tags")
    if len(tags) > 30 or any(len(tag) > 100 for tag in tags) or len(",".join(tags)) > 500:
        raise ValueError("YouTube tags exceed YouTube limits")

    playlist_ids = _string_list(
        values.get("playlist_ids", connector.playlist_ids),
        "YouTube playlist IDs",
    )
    if any(not PLAYLIST_ID_RE.fullmatch(pid) for pid in playlist_ids):
        raise ValueError("A YouTube playlist ID is invalid")

    notify = values.get("notify", connector.notify)
    if not isinstance(notify, bool):
        raise ValueError("YouTube notifications value is invalid")

    return YouTubeUploadSpec(
        title=title,
        description=description,
        privacy=privacy,
        tags=tags,
        playlist_ids=playlist_ids,
        notify=notify,
    )


def build_upload_command(
    executable: str,
    connector: YouTubeConnector,
    clip_path: Path,
    spec: YouTubeUploadSpec,
) -> list[str]:
    command = [
        executable,
        "-quiet",
        "-filename", str(clip_path),
        "-title", spec.title,
        "-description", spec.description,
        "-privacy", spec.privacy,
        "-oAuthPort", str(connector.oauth_port),
    ]
    if spec.tags:
        command.extend(["-tags", ",".join(spec.tags)])
    for playlist_id in spec.playlist_ids:
        command.extend(["-playlistID", playlist_id])
    if connector.secrets_path:
        command.extend(["-secrets", str(_config_path(connector.secrets_path))])
    if connector.cache_path:
        command.extend(["-cache", str(_config_path(connector.cache_path))])
    if not spec.notify:
        command.append("-notify=false")
    return command


async def _read_tail(stream: Optional[asyncio.StreamReader]) -> str:
    if stream is None:
        return ""
    tail = bytearray()
    while True:
        chunk = await stream.read(4096)
        if not chunk:
            break
        tail.extend(chunk)
        if len(tail) > OUTPUT_TAIL_BYTES:
            del tail[:-OUTPUT_TAIL_BYTES]
    return bytes(tail).decode(errors="replace")


def _diagnostic(stdout: str, stderr: str, returncode: Optional[int]) -> str:
    message = (stderr or "").strip()
    if not message:
        lines = [
            line.strip() for line in re.split(r"[\r\n]+", stdout or "")
            if line.strip() and "Video ID:" not in line
        ]
        message = "\n".join(lines[-8:]).strip()
    if not message:
        if returncode is None:
            return "youtubeuploader did not finish"
        return f"youtubeuploader exited with code {returncode}"
    return message[-2000:]


class YouTubeUploadManager:
    """Own one youtubeuploader subprocess and retain its latest result."""

    def __init__(self, broadcast: Callable[[dict], Awaitable[None]]) -> None:
        self._broadcast = broadcast
        self._task: Optional[asyncio.Task] = None
        self._proc: Optional[asyncio.subprocess.Process] = None
        self._state: Optional[dict] = None
        self._canceled = False

    @property
    def busy(self) -> bool:
        return self._task is not None and not self._task.done()

    @property
    def active_slug(self) -> Optional[str]:
        if self.busy and self._state:
            return str(self._state.get("slug") or "") or None
        return None

    def status(self) -> Optional[dict]:
        return dict(self._state) if self._state else None

    def start(
        self,
        *,
        slug: str,
        connector: YouTubeConnector,
        command: list[str],
        spec: YouTubeUploadSpec,
    ) -> dict:
        if self.busy:
            raise YouTubeUploadBusy()
        job_id = f"yt-{int(time.time() * 1000)}"
        self._canceled = False
        self._proc = None
        self._state = {
            "job_id": job_id,
            "slug": slug,
            "connector_id": connector.id,
            "connector_name": connector.name,
            "title": spec.title,
            "status": "uploading",
            "started_at": datetime.now().isoformat(timespec="seconds"),
        }
        self._task = asyncio.create_task(self._run(job_id, command))
        return self.status() or {}

    async def _run(self, job_id: str, command: list[str]) -> None:
        assert self._state is not None
        await self._broadcast({"type": "youtube_upload_started", **self._state})
        try:
            try:
                self._proc = await asyncio.create_subprocess_exec(
                    *command,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
            except OSError as exc:
                await self._finish_error(job_id, str(exc) or "youtubeuploader failed to start")
                return

            if self._canceled and self._proc.returncode is None:
                try:
                    self._proc.terminate()
                except ProcessLookupError:
                    pass

            stdout_task = asyncio.create_task(_read_tail(self._proc.stdout))
            stderr_task = asyncio.create_task(_read_tail(self._proc.stderr))
            await self._proc.wait()
            stdout, stderr = await asyncio.gather(stdout_task, stderr_task)
            video_id = parse_video_id(stdout)
            diagnostic = _diagnostic(stdout, stderr, self._proc.returncode)

            if video_id:
                url = f"https://youtu.be/{video_id}"
                partial = self._proc.returncode != 0 or self._canceled
                if self._canceled:
                    warning = (
                        "The upload completed before cancellation took effect. "
                        "The video already exists on YouTube."
                    )
                else:
                    warning = diagnostic if partial else None
                self._state.update({
                    "status": "partial" if partial else "done",
                    "video_id": video_id,
                    "url": url,
                    "partial": partial,
                    "canceled": self._canceled,
                    "warning": warning,
                    "returncode": self._proc.returncode,
                })
                await self._broadcast({"type": "youtube_upload_done", **self._state})
                return

            if self._canceled:
                await self._finish_error(job_id, "YouTube upload canceled", canceled=True)
                return
            await self._finish_error(job_id, diagnostic)
        finally:
            self._proc = None

    async def _finish_error(
        self, job_id: str, error: str, *, canceled: bool = False
    ) -> None:
        if not self._state or self._state.get("job_id") != job_id:
            return
        self._state.update({
            "status": "canceled" if canceled else "error",
            "error": error[-2000:],
            "canceled": canceled,
        })
        await self._broadcast({"type": "youtube_upload_error", **self._state})

    async def cancel(self, job_id: str) -> bool:
        if not self.busy or not self._state or self._state.get("job_id") != job_id:
            return False
        self._canceled = True
        proc = self._proc
        if proc and proc.returncode is None:
            try:
                proc.terminate()
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(proc.wait(), timeout=3)
            except asyncio.TimeoutError:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
                await proc.wait()
        task = self._task
        if task and task is not asyncio.current_task():
            await task
        return True

    async def shutdown(self) -> None:
        if self.busy and self._state:
            await self.cancel(str(self._state["job_id"]))
