"""Regression tests for the FireShare upload-progress flood/staleness bug.

User symptom: FireShare already shows the video as ready while Vice's own
progress bar keeps climbing. Root cause (confirmed by these tests against
pre-fix code):

  1. ``_ProgressFile.read()`` fires ``on_progress`` on *every* chunk aiohttp
     reads from disk (hundreds of times for a large clip); the old
     ``emit_progress`` unconditionally did ``asyncio.create_task(broadcast)``
     for each one — one task and one WS broadcast per tiny read, with no
     throttling and no ordering guarantee relative to the eventual
     processing/ready transition.
  2. Nothing stopped a still-pending progress broadcast from being delivered
     after the attempt had already moved on to a terminal (or cancelled)
     state, and nothing let the UI detect/drop such a stale/out-of-order
     event for the same (or a superseded) attempt.

The fix introduces ``_ProgressCoalescer`` (bounded-rate, latest-value-wins
progress broadcasting, flushed exactly once before any processing/terminal
transition and closed on every exit path) plus a monotonic per-attempt
``seq`` on every broadcast. This module covers the manager-level behavior;
a companion Node harness (``tests/test_fireshare_progress_ui.py``) covers
the UI's patch-in-place rendering and stale/superseded-attempt rejection.
"""

from __future__ import annotations

import asyncio
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from vice.library import ClipLibrary, ObservedFile

try:
    from vice.fireshare import FireShareJobEnvelope, FireSharePublishManager
except ModuleNotFoundError:  # aiohttp not installed in this environment
    FireShareJobEnvelope = None
    FireSharePublishManager = None


def _ready_envelope():
    return FireShareJobEnvelope(
        job_id="job-1",
        video_id="vid-1",
        public_url="https://fireshare.example.com/v/1",
        path=None,
        status="ready",
        private=None,
        title="t",
        deduplicated=False,
        error=None,
        created_at=None,
        updated_at=None,
    )


class _BurstUploadClient:
    """Stand-in FireShareClient whose upload() calls on_progress many times
    in quick succession (simulating aiohttp's per-chunk synchronous reads
    for a large file) before resolving, so tests can observe how the
    manager turns that burst into outgoing broadcasts."""

    def __init__(self, total: int, ticks: int, *, tick_delay: float = 0.01) -> None:
        self.total = total
        self.ticks = ticks
        self.tick_delay = tick_delay

    async def upload(self, *, on_progress, **_kwargs):
        chunk = max(1, self.total // self.ticks)
        sent = 0
        for _ in range(self.ticks):
            sent = min(self.total, sent + chunk)
            on_progress(sent, self.total)
            if self.tick_delay:
                await asyncio.sleep(self.tick_delay)
        return (200, _ready_envelope(), 2, "deadbeef")

    async def get_status(self, job_id):  # pragma: no cover - not exercised here
        raise AssertionError("get_status should not be called in this test")


class _HangingAfterTicksClient:
    """Emits a handful of progress ticks and then hangs until cancelled —
    used to prove no progress broadcast is delivered after a cancel."""

    def __init__(self, total: int) -> None:
        self.total = total
        self.ticks_done = asyncio.Event()

    async def upload(self, *, on_progress, **_kwargs):
        on_progress(10, self.total)
        on_progress(20, self.total)
        self.ticks_done.set()
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            raise
        raise AssertionError("upload() should have been cancelled")

    async def get_status(self, job_id):  # pragma: no cover - not exercised here
        raise AssertionError("get_status should not be called in this test")


class _ThreadedBurstClient:
    """Calls on_progress thousands of times in rapid succession from a real
    worker thread (via loop.run_in_executor), matching how aiohttp actually
    drives ``_ProgressFile.read()`` — synchronously, off the event loop
    thread, with no gaps at all on a fast local upload. Stresses the
    coalescer's thread-safety and its "at most one event-loop hand-off per
    throttle window" behavior far harder than a same-thread await-spaced
    burst can."""

    def __init__(self, total: int, ticks: int) -> None:
        self.total = total
        self.ticks = ticks

    async def upload(self, *, on_progress, **_kwargs):
        loop = asyncio.get_running_loop()
        chunk = max(1, self.total // self.ticks)

        def _read_all() -> None:
            sent = 0
            for _ in range(self.ticks):
                sent = min(self.total, sent + chunk)
                on_progress(sent, self.total)

        await loop.run_in_executor(None, _read_all)
        return (200, _ready_envelope(), 2, "deadbeef")

    async def get_status(self, job_id):  # pragma: no cover - not exercised here
        raise AssertionError("get_status should not be called in this test")


@unittest.skipUnless(FireSharePublishManager is not None, "aiohttp is not installed")
class FireSharePublishProgressTests(unittest.IsolatedAsyncioTestCase):
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
        self.broadcast_times: list[float] = []

        async def broadcast(msg: dict) -> None:
            self.broadcasts.append(msg)
            self.broadcast_times.append(time.monotonic())

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
        # Started (not `with`) and stopped at teardown: the background task
        # doesn't reach `FireShareClient(...)` until after this returns.
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

    def _progress_events(self) -> list[dict]:
        return [m for m in self.broadcasts if m.get("type") == "fireshare_publish_progress"]

    async def test_rapid_progress_burst_produces_bounded_broadcasts(self) -> None:
        """Requirement: throttle/coalesce backend upload progress by time
        and/or byte threshold with latest-value-wins; do not create one
        async task per small read. 40 reads spread over ~0.4s must collapse
        to far fewer than 40 broadcasts."""
        total = 4000
        ticks = 40
        client = _BurstUploadClient(total, ticks, tick_delay=0.01)
        attempt_id = await self._start_publish(client)
        task = self.manager._tasks.get(attempt_id)
        self.assertIsNotNone(task)
        await asyncio.wait_for(task, timeout=5)

        progress_events = self._progress_events()
        self.assertGreater(len(progress_events), 0, "at least one progress broadcast must still occur")
        self.assertLess(
            len(progress_events),
            ticks,
            "progress broadcasts must be coalesced, not emitted once per read()",
        )

    async def test_progress_broadcasts_deliver_latest_value_not_every_tick(self) -> None:
        """Coalesced broadcasts must be latest-value-wins: every delivered
        sent_bytes value must be non-decreasing, and the very last one must
        equal the true final byte count (100%), even though most of the
        individual read() ticks were absorbed rather than broadcast."""
        total = 4000
        ticks = 40
        client = _BurstUploadClient(total, ticks, tick_delay=0.01)
        attempt_id = await self._start_publish(client)
        task = self.manager._tasks.get(attempt_id)
        await asyncio.wait_for(task, timeout=5)

        progress_events = self._progress_events()
        sent_values = [m["sent_bytes"] for m in progress_events]
        self.assertEqual(sent_values, sorted(sent_values), "progress must never move backwards")
        self.assertEqual(sent_values[-1], total, "the final coalesced tick must report 100%")

    async def test_final_progress_ordered_before_processing_transition(self) -> None:
        """Requirement: a final 100% progress update must be emitted/ordered
        before the processing/remote envelope transition; no progress event
        may arrive after processing/ready/failed/canceled."""
        total = 4000
        ticks = 40
        client = _BurstUploadClient(total, ticks, tick_delay=0.01)
        attempt_id = await self._start_publish(client)
        task = self.manager._tasks.get(attempt_id)
        await asyncio.wait_for(task, timeout=5)

        types = [m.get("type") for m in self.broadcasts]
        last_progress_idx = max(i for i, t in enumerate(types) if t == "fireshare_publish_progress")
        first_terminal_idx = min(
            i for i, t in enumerate(types) if t in {"fireshare_publish_processing", "fireshare_publish_ready"}
        )
        self.assertLess(
            last_progress_idx, first_terminal_idx,
            "the final progress tick must be broadcast before the processing/ready transition",
        )
        self.assertEqual(self.broadcasts[last_progress_idx]["sent_bytes"], total)
        # No progress broadcast may follow any processing/ready/failed event.
        for i, t in enumerate(types):
            if t in {"fireshare_publish_processing", "fireshare_publish_ready", "fireshare_publish_failed"}:
                later_progress = [j for j in range(i + 1, len(types)) if types[j] == "fireshare_publish_progress"]
                self.assertEqual(later_progress, [], "no progress tick may arrive after a terminal transition")

    async def test_no_progress_broadcast_after_cancellation(self) -> None:
        """Requirement 6: cancellation must cancel/flush any pending
        coalesced progress callback so no upload tick arrives after the
        canceled state."""
        client = _HangingAfterTicksClient(total=1000)
        attempt_id = await self._start_publish(client)
        await asyncio.wait_for(client.ticks_done.wait(), timeout=2)
        # Give the coalescer's first throttle window a moment to actually
        # fire so there is at least one real progress broadcast already.
        await asyncio.sleep(0.05)

        await self.manager.cancel(attempt_id)
        broadcasts_at_cancel = list(self.broadcasts)
        # Nothing further should be scheduled/delivered after this point;
        # give the loop a beat to prove no straggling task fires late.
        await asyncio.sleep(0.3)

        self.assertEqual(
            self.broadcasts, broadcasts_at_cancel,
            "no broadcast (progress or otherwise) may arrive after cancel() returns",
        )
        progress_after_cancel = [
            m for m in self.broadcasts
            if m.get("type") == "fireshare_publish_progress"
        ]
        canceled_idx = next(i for i, m in enumerate(self.broadcasts) if m.get("state") == "canceled")
        for i, m in enumerate(self.broadcasts):
            if m.get("type") == "fireshare_publish_progress":
                self.assertLess(i, canceled_idx, "a progress tick must never follow the canceled broadcast")

    async def test_broadcasts_carry_monotonic_per_attempt_sequence(self) -> None:
        """Requirement 4: monotonic attempt event sequencing so stale/
        lower-order progress cannot overwrite a terminal/newer state."""
        total = 2000
        ticks = 20
        client = _BurstUploadClient(total, ticks, tick_delay=0.01)
        attempt_id = await self._start_publish(client)
        task = self.manager._tasks.get(attempt_id)
        await asyncio.wait_for(task, timeout=5)

        seqs = [m["seq"] for m in self.broadcasts if m.get("attempt_id") == attempt_id]
        self.assertTrue(len(seqs) >= 2)
        self.assertEqual(seqs, sorted(seqs), "sequence numbers must be non-decreasing")
        self.assertEqual(len(seqs), len(set(seqs)), "sequence numbers must be strictly unique per attempt")

    async def test_zero_byte_file_never_emits_progress_but_still_completes(self) -> None:
        """A zero-byte file (no read() calls at all, per _ProgressFile) must
        not blow up the coalescer's flush()/close() calls."""
        client = _BurstUploadClient(total=0, ticks=0, tick_delay=0.0)

        async def upload(*, on_progress, **_kwargs):
            return (200, _ready_envelope(), 2, "deadbeef")

        client.upload = upload  # no ticks at all
        attempt_id = await self._start_publish(client)
        task = self.manager._tasks.get(attempt_id)
        await asyncio.wait_for(task, timeout=5)

        self.assertEqual(self._progress_events(), [])
        persisted = self.library.get_fireshare_attempt(attempt_id)
        self.assertEqual(persisted["state"], "ready")

    async def test_threaded_stress_burst_from_worker_thread_produces_bounded_broadcasts(self) -> None:
        """Stress regression (fast local/LAN upload): aiohttp's real reads
        happen on an executor thread, not the event loop thread. Thousands
        of on_progress() calls in rapid succession from an actual separate
        OS thread — with zero gaps, as a fast local upload would produce —
        must still collapse to a tiny, bounded number of broadcasts (not
        one call_soon_threadsafe/task per chunk), preserve the final-100%-
        before-processing ordering, and never crash from the cross-thread
        access."""
        total = 200_000
        ticks = 5000
        client = _ThreadedBurstClient(total, ticks)
        attempt_id = await self._start_publish(client)
        task = self.manager._tasks.get(attempt_id)
        self.assertIsNotNone(task)
        await asyncio.wait_for(task, timeout=10)

        progress_events = self._progress_events()
        self.assertGreater(len(progress_events), 0)
        self.assertLess(
            len(progress_events), 50,
            f"{ticks} rapid worker-thread reads produced {len(progress_events)} broadcasts; "
            "must be bounded, nowhere near one per chunk",
        )
        self.assertEqual(progress_events[-1]["sent_bytes"], total, "the final tick must report 100%")

        types = [m.get("type") for m in self.broadcasts]
        last_progress_idx = max(i for i, t in enumerate(types) if t == "fireshare_publish_progress")
        first_terminal_idx = min(
            i for i, t in enumerate(types) if t in {"fireshare_publish_processing", "fireshare_publish_ready"}
        )
        self.assertLess(
            last_progress_idx, first_terminal_idx,
            "even under a heavy worker-thread burst, the final progress tick must precede processing/ready",
        )

    async def test_coalescer_hands_off_to_event_loop_once_per_window_not_per_chunk(self) -> None:
        """Directly proves the stricter requirement: avoid enqueueing a
        per-chunk event-loop callback (not just a per-chunk *task*).
        ``update()`` must be callable straight from a worker thread and
        must invoke ``call_soon_threadsafe`` only once per throttle window
        — i.e. far fewer times than it's called, even under thousands of
        zero-delay calls from a real separate OS thread."""
        from vice.fireshare import _ProgressCoalescer

        loop = asyncio.get_running_loop()
        handoff_count = 0
        real_call_soon_threadsafe = loop.call_soon_threadsafe

        def counting_call_soon_threadsafe(callback, *args):
            nonlocal handoff_count
            handoff_count += 1
            return real_call_soon_threadsafe(callback, *args)

        class _CountingLoopProxy:
            """Forwards everything to the real loop except call_soon_threadsafe,
            which is intercepted purely to count hand-offs."""

            def __getattr__(self, name):
                return getattr(loop, name)

            def call_soon_threadsafe(self, callback, *args):
                return counting_call_soon_threadsafe(callback, *args)

        emitted: list[tuple[int, int]] = []

        async def emit(sent: int, total: int) -> None:
            emitted.append((sent, total))

        coalescer = _ProgressCoalescer(_CountingLoopProxy(), emit)

        calls = 5000
        done = asyncio.Event()

        def _hammer() -> None:
            for i in range(calls):
                coalescer.update(i, calls)
            loop.call_soon_threadsafe(done.set)

        await loop.run_in_executor(None, _hammer)
        await asyncio.wait_for(done.wait(), timeout=5)
        await coalescer.flush()

        self.assertLess(
            handoff_count, 50,
            f"{calls} update() calls from a worker thread triggered {handoff_count} "
            "call_soon_threadsafe hand-offs; must be roughly one per throttle window, not per chunk",
        )
        self.assertGreater(handoff_count, 0)
        self.assertEqual(emitted[-1], (calls - 1, calls), "the flushed final value must be the true last update")

    async def test_progress_broadcasts_bounded_to_five_per_second(self) -> None:
        """Requirement: coalesce/throttle backend progress to <=5 updates/
        sec (plus the guaranteed final 100%). Rather than asserting an
        absolute broadcast count (sensitive to this machine/CI's incidental
        scheduling overhead), assert the actual *rate*: every consecutive
        pair of throttled progress broadcasts must be spaced by (close to)
        the MIN_INTERVAL throttle window, i.e. no more than 5/sec."""
        from vice.fireshare import _ProgressCoalescer

        total = 2000
        ticks = 100
        client = _BurstUploadClient(total, ticks, tick_delay=0.01)
        attempt_id = await self._start_publish(client)
        task = self.manager._tasks.get(attempt_id)
        await asyncio.wait_for(task, timeout=5)

        progress_indices = [i for i, m in enumerate(self.broadcasts) if m.get("type") == "fireshare_publish_progress"]
        self.assertGreater(len(progress_indices), 1, "need at least two throttled ticks to check spacing")
        # The very last progress broadcast is the flush()-forced final 100%,
        # which intentionally bypasses the throttle to guarantee it lands
        # promptly (not gated behind a stale window) — everything before it
        # must still respect the <=5/sec throttle spacing.
        throttled_times = [self.broadcast_times[i] for i in progress_indices[:-1]]
        gaps = [b - a for a, b in zip(throttled_times, throttled_times[1:])]
        for gap in gaps:
            self.assertGreaterEqual(
                gap, _ProgressCoalescer.MIN_INTERVAL * 0.8,
                f"throttled progress broadcasts must be spaced >= ~{_ProgressCoalescer.MIN_INTERVAL}s apart "
                f"(<=5/sec), got a {gap:.3f}s gap",
            )

    async def test_processing_broadcast_follows_upload_quickly(self) -> None:
        """Requirement: the processing/ready transition (and thus the
        public link becoming available in the UI) must appear promptly —
        well under a second locally — after the upload's HTTP response,
        not be delayed by the progress-throttling machinery."""
        total = 2000
        ticks = 20
        client = _BurstUploadClient(total, ticks, tick_delay=0.005)
        start = time.monotonic()
        attempt_id = await self._start_publish(client)
        task = self.manager._tasks.get(attempt_id)
        await asyncio.wait_for(task, timeout=5)

        types = [m.get("type") for m in self.broadcasts]
        first_terminal_idx = min(
            i for i, t in enumerate(types) if t in {"fireshare_publish_processing", "fireshare_publish_ready"}
        )
        terminal_time = self.broadcast_times[first_terminal_idx]
        upload_wall_time = ticks * 0.005
        # The processing broadcast must land within ~250ms of the upload's
        # own reads finishing, not be stuck behind an extra throttle delay.
        self.assertLess(
            terminal_time - start - upload_wall_time,
            0.25,
            "the processing/ready broadcast must follow the upload's completion promptly, "
            "not be gated behind the progress-coalescing throttle window",
        )


if __name__ == "__main__":
    unittest.main()
