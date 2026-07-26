import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from vice.config import Config
from vice.fireshare import (
    _CompletionPayload,
    FireShareJobEnvelope,
    FireSharePublishManager,
)
from vice.library import ClipLibrary, ObservedFile

try:
    from vice.share import ShareServer
except ModuleNotFoundError:  # aiohttp not installed in this environment
    ShareServer = None


class _CancelRequest:
    def __init__(self, attempt_id: str) -> None:
        self.match_info = {"aid": attempt_id}


class _BlockingClient:
    def __init__(self, *, complete_body: bool = False) -> None:
        self.entered = asyncio.Event()
        self.canceled = asyncio.Event()
        self.complete_body = complete_body

    async def upload(self, **kwargs):
        if self.complete_body:
            kwargs["on_progress"](10, 10)
            kwargs["on_upload_complete"]()
        self.entered.set()
        try:
            await asyncio.Future()
        except asyncio.CancelledError:
            self.canceled.set()
            raise


class _ProcessingClient:
    def __init__(self) -> None:
        self.polling = asyncio.Event()

    async def upload(self, **_kwargs):
        return (
            202,
            FireShareJobEnvelope(
                job_id="job-1",
                video_id=None,
                public_url=None,
                path=None,
                status="processing",
                private=None,
                title=None,
                deduplicated=False,
                error=None,
                created_at=None,
                updated_at=None,
            ),
            1,
            "source-hash",
        )

    async def get_status(self, _job_id):
        self.polling.set()
        await asyncio.Future()


class _BlockingPayload:
    def __init__(self) -> None:
        self.headers = {"Content-Type": "multipart/form-data; boundary=test"}
        self.size = 20
        self.entered = asyncio.Event()
        self.release = asyncio.Event()

    async def write(self, writer) -> None:
        await writer.write(b"file-part")
        self.entered.set()
        await self.release.wait()
        await writer.write(b"closing-boundary")


class _CollectingWriter:
    def __init__(self) -> None:
        self.chunks: list[bytes] = []

    async def write(self, chunk: bytes) -> None:
        self.chunks.append(chunk)


@unittest.skipUnless(ShareServer is not None, "aiohttp is not installed")
class FireShareCancelTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        root = Path(self._tmp.name)

        self.library = ClipLibrary(root / "library.sqlite3")
        self.addCleanup(self.library.close)
        self.clip_uuid = self.library.catalog_clip(
            ObservedFile(slug="Clip_1", size=10, mtime_ns=1)
        )
        self.clip_path = root / "Clip_1.mp4"
        self.clip_path.write_bytes(b"clip-bytes")
        self.broadcasts: list[dict] = []

        async def broadcast(message: dict) -> None:
            self.broadcasts.append(message)

        def resolve_clip(slug: str):
            if slug != "Clip_1":
                return None
            return {
                "slug": slug,
                "path": self.clip_path,
                "uuid": self.clip_uuid,
                "game": "",
            }

        self.manager = FireSharePublishManager(
            library=self.library,
            broadcast=broadcast,
            resolve_clip=resolve_clip,
            resolve_clip_by_uuid=lambda clip_uuid: (
                resolve_clip("Clip_1") if clip_uuid == self.clip_uuid else None
            ),
        )
        self.server = ShareServer(Config())
        self.server._fireshare = self.manager

    async def test_upload_completion_waits_for_final_socket_write(self) -> None:
        complete = asyncio.Event()
        inner = _BlockingPayload()
        writer = _CollectingWriter()
        payload = _CompletionPayload(inner, on_complete=complete.set)

        write_task = asyncio.create_task(payload.write(writer))
        await asyncio.wait_for(inner.entered.wait(), timeout=1)
        self.assertFalse(complete.is_set())

        inner.release.set()
        await asyncio.wait_for(write_task, timeout=1)
        self.assertTrue(complete.is_set())
        self.assertEqual(writer.chunks, [b"file-part", b"closing-boundary"])

    async def test_active_cancel_aborts_upload_persists_and_broadcasts(self) -> None:
        client = _BlockingClient()
        with mock.patch("vice.fireshare.FireShareClient", return_value=client):
            started = await self.manager.publish(
                slug="Clip_1",
                base_url="https://fireshare.example.com",
                token="token",
                options={"private": None},
            )
            await asyncio.wait_for(client.entered.wait(), timeout=1)

            response = await self.server._api_fireshare_cancel(
                _CancelRequest(started["attempt_id"])
            )

        payload = json.loads(response.text)
        attempt = self.library.get_fireshare_attempt(started["attempt_id"])
        self.assertEqual(response.status, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["attempt"]["state"], "canceled")
        self.assertTrue(client.canceled.is_set())
        self.assertEqual(attempt["state"], "canceled")
        self.assertEqual(attempt["error_code"], "canceled")
        self.assertTrue(
            any(
                event.get("type") == "fireshare_publish_failed"
                and event.get("state") == "canceled"
                for event in self.broadcasts
            )
        )

    async def test_cancel_is_rejected_after_last_byte_is_sent(self) -> None:
        client = _BlockingClient(complete_body=True)
        with mock.patch("vice.fireshare.FireShareClient", return_value=client):
            started = await self.manager.publish(
                slug="Clip_1",
                base_url="https://fireshare.example.com",
                token="token",
                options={"private": None},
            )
            await asyncio.wait_for(client.entered.wait(), timeout=1)

            response = await self.server._api_fireshare_cancel(
                _CancelRequest(started["attempt_id"])
            )

            payload = json.loads(response.text)
            self.assertEqual(response.status, 409)
            self.assertEqual(payload["error_code"], "upload_already_sent")
            self.assertFalse(payload["cancelable"])
            self.assertFalse(client.canceled.is_set())
            publication = self.manager.get_clip_publication(self.clip_uuid)
            self.assertFalse(publication["current"]["cancelable"])
            await self.manager.shutdown()

        attempt = self.library.get_fireshare_attempt(started["attempt_id"])
        self.assertEqual(attempt["state"], "uploading")

    async def test_shutdown_does_not_mark_remote_processing_as_canceled(self) -> None:
        client = _ProcessingClient()
        with mock.patch("vice.fireshare.FireShareClient", return_value=client):
            started = await self.manager.publish(
                slug="Clip_1",
                base_url="https://fireshare.example.com",
                token="token",
                options={"private": None},
            )
            await asyncio.wait_for(client.polling.wait(), timeout=2)
            await self.manager.shutdown()

        attempt = self.library.get_fireshare_attempt(started["attempt_id"])
        self.assertEqual(attempt["state"], "processing")
        self.assertFalse(
            any(
                event.get("state") == "canceled"
                for event in self.broadcasts
            )
        )

    async def test_missing_attempt_returns_json_not_found(self) -> None:
        response = await self.server._api_fireshare_cancel(
            _CancelRequest("missing-attempt")
        )
        payload = json.loads(response.text)

        self.assertEqual(response.status, 404)
        self.assertEqual(response.content_type, "application/json")
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error_code"], "not_found")
        self.assertIsNone(payload["state"])

    async def test_finished_attempt_returns_json_conflict_with_state(self) -> None:
        self.library.save_fireshare_attempt({
            "attempt_id": "processing-attempt",
            "clip_uuid": self.clip_uuid,
            "idempotency_key": "processing-attempt",
            "state": "processing",
        })

        response = await self.server._api_fireshare_cancel(
            _CancelRequest("processing-attempt")
        )
        payload = json.loads(response.text)

        self.assertEqual(response.status, 409)
        self.assertEqual(response.content_type, "application/json")
        self.assertEqual(payload["error_code"], "attempt_not_cancelable")
        self.assertEqual(payload["state"], "processing")

    async def test_uploading_attempt_missing_from_task_registry_returns_json_conflict(self) -> None:
        self.library.save_fireshare_attempt({
            "attempt_id": "raced-attempt",
            "clip_uuid": self.clip_uuid,
            "idempotency_key": "raced-attempt",
            "state": "uploading",
        })

        response = await self.server._api_fireshare_cancel(
            _CancelRequest("raced-attempt")
        )
        payload = json.loads(response.text)

        self.assertEqual(response.status, 409)
        self.assertEqual(response.content_type, "application/json")
        self.assertEqual(payload["error_code"], "attempt_not_active")
        self.assertEqual(payload["state"], "uploading")
        self.assertFalse(payload["cancelable"])

    async def test_cancel_while_started_broadcast_is_blocked_still_persists(self) -> None:
        broadcast_started = asyncio.Event()

        async def blocked_broadcast(message: dict) -> None:
            if message.get("type") == "fireshare_publish_started":
                broadcast_started.set()
                await asyncio.Future()
            self.broadcasts.append(message)

        self.manager._broadcast = blocked_broadcast
        started = await self.manager.publish(
            slug="Clip_1",
            base_url="https://fireshare.example.com",
            token="token",
            options={"private": None},
        )
        await asyncio.wait_for(broadcast_started.wait(), timeout=1)

        response = await self.server._api_fireshare_cancel(
            _CancelRequest(started["attempt_id"])
        )
        payload = json.loads(response.text)
        attempt = self.library.get_fireshare_attempt(started["attempt_id"])

        self.assertEqual(response.status, 200)
        self.assertEqual(payload["attempt"]["state"], "canceled")
        self.assertEqual(attempt["state"], "canceled")
        self.assertNotIn(started["attempt_id"], self.manager._tasks)


if __name__ == "__main__":
    unittest.main()
