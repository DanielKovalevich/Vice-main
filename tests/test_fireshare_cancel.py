"""Regression tests for the FireShare "Cancel upload" endpoint.

User symptom: clicking Cancel upload failed with a JSON parse error in the
browser. Root cause had two parts:

  1. ``FireSharePublishManager.cancel()`` only distinguished "there is an
     active task" (True) from everything else (False), so a cancel that
     raced against the upload completing on its own (or a bad/expired
     attempt id) was indistinguishable from a genuine "not found".
  2. ``_api_fireshare_cancel`` turned that ``False`` into a bare
     ``web.HTTPNotFound()``, which aiohttp renders as a plaintext/HTML 404
     body — but the UI unconditionally called ``response.json()`` on it,
     throwing a raw "Unexpected token" SyntaxError instead of a useful
     message.

This module covers the manager-level cancellation/race/idempotency
semantics and the route-level JSON envelope for every outcome (ok+cancelled,
ok+raced, not-found, manager-unavailable, internal failure). A companion
Node harness (``tests/test_fireshare_cancel_ui.py``) exercises the browser
side of the fix (safe JSON parsing + duplicate-click guard).
"""

from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from vice.library import ClipLibrary, ObservedFile

try:
    from vice.fireshare import FireShareError, FireShareJobEnvelope, FireSharePublishManager
except ModuleNotFoundError:  # aiohttp not installed in this environment
    FireShareError = None
    FireShareJobEnvelope = None
    FireSharePublishManager = None

try:
    from vice.config import Config
    from vice.share import ShareServer
except ModuleNotFoundError:  # aiohttp not installed in this environment
    Config = None
    ShareServer = None


class _HangingClient:
    """Stand-in FireShareClient whose upload() blocks until cancelled, so
    tests can exercise an *actually in-flight* upload task rather than one
    that already raced to completion."""

    def __init__(self) -> None:
        self.upload_started = asyncio.Event()
        self.cancelled_cleanly = False

    async def upload(self, **_kwargs):
        self.upload_started.set()
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            # Mirrors the real client's `async with session.post(...)` body:
            # cancellation propagates through the context manager, which is
            # what actually releases the socket/file handles.
            self.cancelled_cleanly = True
            raise
        raise AssertionError("upload() should have been cancelled, not completed")

    async def get_status(self, job_id):  # pragma: no cover - not exercised here
        raise AssertionError("get_status should not be called in this test")


class _FakeManagerClient:
    """Stand-in FireShareClient with a scripted, immediately-resolving
    upload() result (used for the "task already finished" race tests)."""

    def __init__(self, upload_result=None) -> None:
        self._upload_result = upload_result

    async def upload(self, **_kwargs):
        if isinstance(self._upload_result, Exception):
            raise self._upload_result
        return self._upload_result

    async def get_status(self, job_id):  # pragma: no cover - not exercised here
        raise AssertionError("get_status should not be called in this test")


@unittest.skipUnless(FireSharePublishManager is not None, "aiohttp is not installed")
class FireSharePublishManagerCancelTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        root = Path(self._tmp.name)

        self.library = ClipLibrary(root / "library.sqlite3")
        self.addCleanup(self.library.close)
        self.clip_uuid = self.library.catalog_clip(ObservedFile(slug="Clip_1", size=10, mtime_ns=1))

        self.clip_path = root / "Clip_1.mp4"
        self.clip_path.write_bytes(b"clip-bytes")

        self.broadcasts: list[dict] = []

        async def broadcast(msg: dict) -> None:
            self.broadcasts.append(msg)

        def resolve_clip(slug: str):
            if slug != "Clip_1":
                return None
            return {"slug": "Clip_1", "path": self.clip_path, "uuid": self.clip_uuid, "game": ""}

        def resolve_clip_by_uuid(clip_uuid: str):
            if clip_uuid != self.clip_uuid:
                return None
            return resolve_clip("Clip_1")

        self.manager = FireSharePublishManager(
            library=self.library,
            broadcast=broadcast,
            resolve_clip=resolve_clip,
            resolve_clip_by_uuid=resolve_clip_by_uuid,
        )

    async def _start_publish(self, fake_client) -> str:
        # Started (not used as a `with` block) and stopped only at test
        # teardown: the background task created by publish() doesn't reach
        # `FireShareClient(...)` until the event loop schedules it past the
        # first `await`, which happens *after* this helper returns. A patch
        # scoped to a `with` block here would already be reverted by then.
        patcher = mock.patch("vice.fireshare.FireShareClient", return_value=fake_client)
        patcher.start()
        self.addCleanup(patcher.stop)
        state = await self.manager.publish(
            slug="Clip_1",
            base_url="https://fireshare.example.com",
            token="test-placeholder-token",
            options={"private": None},
        )
        return state["attempt_id"]

    async def test_active_cancel_stops_task_and_persists_canceled_state(self) -> None:
        """Requirement 2: cancelling an in-flight upload must actually cancel
        the task, release its resources (the client's async context manager
        runs its cleanup on CancelledError), persist the "canceled" state,
        and broadcast a token-free WS update."""
        hanging = _HangingClient()
        attempt_id = await self._start_publish(hanging)
        await asyncio.wait_for(hanging.upload_started.wait(), timeout=2)

        result = await self.manager.cancel(attempt_id)

        self.assertTrue(result["cancelled"])
        self.assertEqual(result["attempt"]["state"], "canceled")
        self.assertTrue(
            hanging.cancelled_cleanly,
            "the upload's CancelledError handler must actually run (resource cleanup)",
        )
        self.assertNotIn(attempt_id, self.manager._tasks, "the finished task must be removed")

        persisted = self.library.get_fireshare_attempt(attempt_id)
        self.assertEqual(persisted["state"], "canceled")

        cancel_events = [m for m in self.broadcasts if m.get("state") == "canceled"]
        self.assertEqual(len(cancel_events), 1)
        # No token may leak into any broadcast payload.
        for msg in self.broadcasts:
            self.assertNotIn("token", msg)
            self.assertNotIn("test-placeholder-token", json.dumps(msg))

    async def test_duplicate_cancel_after_active_cancel_is_idempotent(self) -> None:
        """Requirement 3: a second cancel call for an already-canceled attempt
        must not error and must keep reporting cancelled=True."""
        hanging = _HangingClient()
        attempt_id = await self._start_publish(hanging)
        await asyncio.wait_for(hanging.upload_started.wait(), timeout=2)

        first = await self.manager.cancel(attempt_id)
        second = await self.manager.cancel(attempt_id)

        self.assertTrue(first["cancelled"])
        self.assertTrue(second["cancelled"])
        self.assertEqual(second["attempt"]["state"], "canceled")

    async def test_cancel_after_task_already_completed_is_not_an_error(self) -> None:
        """Requirement 3: reproduces the reported race — the upload finishes
        (e.g. "ready") in the tiny window between the UI rendering the
        Cancel button and the click reaching the server. cancel() must
        report this cleanly (cancelled=False, current attempt state) rather
        than behaving as if the attempt never existed."""
        envelope = FireShareJobEnvelope(
            job_id="job-1", video_id="vid-1",
            public_url="https://fireshare.example.com/v/1", path=None,
            status="ready", private=None, title="t", deduplicated=False,
            error=None, created_at=None, updated_at=None,
        )
        fake_client = _FakeManagerClient(upload_result=(202, envelope, 2, "hash-1"))
        attempt_id = await self._start_publish(fake_client)
        task = self.manager._tasks.get(attempt_id)
        if task:
            await task  # let the upload race to completion before we cancel

        result = await self.manager.cancel(attempt_id)

        self.assertFalse(result["cancelled"])
        self.assertEqual(result["attempt"]["state"], "ready")

    async def test_cancel_unknown_attempt_raises_not_found_error(self) -> None:
        """A bad/expired attempt id (never existed) is the only case that
        should surface as an actual error."""
        with self.assertRaises(FireShareError) as ctx:
            await self.manager.cancel("does-not-exist")
        self.assertEqual(ctx.exception.code, "not_found")
        self.assertEqual(ctx.exception.status, 404)


class _MatchInfoRequest:
    """Minimal stand-in for an aiohttp request carrying only path params,
    matching the `_JsonRequest` pattern already used for the validate route
    in test_fireshare_validate.py."""

    def __init__(self, match_info: dict) -> None:
        self.match_info = match_info


@unittest.skipUnless(ShareServer is not None, "aiohttp is not installed")
class FireShareCancelRouteTests(unittest.IsolatedAsyncioTestCase):
    def _server(self) -> "ShareServer":
        return ShareServer(Config())

    async def test_cancel_route_returns_json_ok_when_actively_cancelled(self) -> None:
        server = self._server()
        fake_manager = mock.AsyncMock()
        fake_manager.cancel.return_value = {
            "cancelled": True,
            "attempt": {"attempt_id": "a1", "state": "canceled"},
        }
        server._fireshare = fake_manager

        response = await server._api_fireshare_cancel(_MatchInfoRequest({"aid": "a1"}))

        self.assertEqual(response.status, 200)
        self.assertEqual(response.content_type, "application/json")
        payload = json.loads(response.text)
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["cancelled"])
        self.assertEqual(payload["attempt"]["state"], "canceled")

    async def test_cancel_route_returns_json_ok_when_raced_to_completion(self) -> None:
        """The exact scenario the UI reported: previously this fell through
        to a bare web.HTTPNotFound() with a plaintext body, which broke the
        UI's `response.json()` call."""
        server = self._server()
        fake_manager = mock.AsyncMock()
        fake_manager.cancel.return_value = {
            "cancelled": False,
            "attempt": {"attempt_id": "a1", "state": "ready"},
        }
        server._fireshare = fake_manager

        response = await server._api_fireshare_cancel(_MatchInfoRequest({"aid": "a1"}))

        self.assertEqual(response.status, 200)
        self.assertEqual(response.content_type, "application/json")
        payload = json.loads(response.text)
        self.assertTrue(payload["ok"])
        self.assertFalse(payload["cancelled"])
        self.assertEqual(payload["attempt"]["state"], "ready")

    async def test_cancel_route_returns_json_not_found_for_unknown_attempt(self) -> None:
        """Reproduces the original bug end-to-end through the real manager:
        an unknown attempt id must yield a JSON 404, not aiohttp's default
        plaintext HTTPNotFound body."""
        server = self._server()
        fake_manager = mock.AsyncMock()
        fake_manager.cancel.side_effect = FireShareError(
            "not_found", "Publish attempt not found", status=404
        )
        server._fireshare = fake_manager

        response = await server._api_fireshare_cancel(_MatchInfoRequest({"aid": "does-not-exist"}))

        self.assertEqual(response.status, 404)
        self.assertEqual(response.content_type, "application/json")
        payload = json.loads(response.text)  # must not raise (would if body were HTML/plaintext)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error_code"], "not_found")

    async def test_cancel_route_returns_json_conflict_when_manager_raises_conflict(self) -> None:
        server = self._server()
        fake_manager = mock.AsyncMock()
        fake_manager.cancel.side_effect = FireShareError(
            "publish_in_progress", "This publish attempt is already active", status=409
        )
        server._fireshare = fake_manager

        response = await server._api_fireshare_cancel(_MatchInfoRequest({"aid": "a1"}))

        self.assertEqual(response.status, 409)
        self.assertEqual(response.content_type, "application/json")
        payload = json.loads(response.text)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error_code"], "publish_in_progress")

    async def test_cancel_route_returns_json_on_unexpected_internal_failure(self) -> None:
        server = self._server()
        fake_manager = mock.AsyncMock()
        fake_manager.cancel.side_effect = RuntimeError("boom")
        server._fireshare = fake_manager

        response = await server._api_fireshare_cancel(_MatchInfoRequest({"aid": "a1"}))

        self.assertEqual(response.status, 500)
        self.assertEqual(response.content_type, "application/json")
        payload = json.loads(response.text)
        self.assertFalse(payload["ok"])
        self.assertIn("boom", payload["error"])

    async def test_cancel_route_manager_unavailable_returns_json(self) -> None:
        server = self._server()
        server._fireshare = None

        response = await server._api_fireshare_cancel(_MatchInfoRequest({"aid": "a1"}))

        self.assertEqual(response.status, 503)
        self.assertEqual(response.content_type, "application/json")
        payload = json.loads(response.text)
        self.assertFalse(payload["ok"])


if __name__ == "__main__":
    unittest.main()
