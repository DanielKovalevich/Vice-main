"""Regression tests for the tri-state FireShare privacy contract:

  * ``server_default`` / ``public`` / ``private`` end-to-end, never silently
    coerced to "public" when the caller made no explicit choice.
  * *requested* privacy (what we asked FireShare for, nullable) kept distinct
    from *effective* privacy (what FireShare actually applied, nullable until
    it responds).
  * legacy boolean ``fireshare.default_private`` configs migrate to
    ``server_default`` rather than being reinterpreted as an explicit choice.

These exercise the real ``FireShareClient``, ``FireSharePublishManager``, and
``vice.config.load`` code paths; only the network layer is stubbed out.
"""

import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from vice.config import (
    FIRESHARE_PRIVACY_VALUES,
    fireshare_privacy_from_bool,
    fireshare_privacy_to_bool,
)
from vice.library import ClipLibrary, ObservedFile

try:
    from vice.fireshare import (
        FireShareClient,
        FireShareError,
        FireShareJobEnvelope,
        FireSharePublishManager,
        _hash_file_sha256,
    )
except ModuleNotFoundError:  # pragma: no cover - aiohttp missing
    FireShareClient = None


# ---------------------------------------------------------------------------
# Helpers for stubbing the network layer used by FireShareClient.upload()
# ---------------------------------------------------------------------------

class _FakeFormData:
    """Stand-in for aiohttp.FormData that just records add_field() calls."""

    def __init__(self) -> None:
        self.fields: list[tuple[str, object]] = []

    def add_field(self, name, value=None, **_kwargs) -> None:
        self.fields.append((name, value))


class _FakeUploadResponse:
    def __init__(self, status: int = 202, payload: dict | None = None) -> None:
        self.status = status
        self._text = json.dumps(payload or {"job_id": "job-1", "status": "accepted"})
        self.headers: dict = {}

    async def text(self) -> str:
        return self._text

    async def __aenter__(self) -> "_FakeUploadResponse":
        return self

    async def __aexit__(self, *exc_info) -> bool:
        return False


class _FakeUploadSession:
    def __init__(self, response: _FakeUploadResponse) -> None:
        self._response = response
        self.requested_headers: list[dict] = []

    def post(self, url, data=None, headers=None):
        self.requested_headers.append(dict(headers or {}))
        # Simulate aiohttp's real chunked read loop over the multipart file
        # field (normally driven from an executor thread) so tests observe
        # the same incremental SHA-256 that _ProgressFile accumulates in
        # production, without needing a real network stack.
        if data is not None:
            for name, value in getattr(data, "fields", []):
                if name == "file" and hasattr(value, "read"):
                    while value.read(4096):
                        pass
        return self._response

    async def __aenter__(self) -> "_FakeUploadSession":
        return self

    async def __aexit__(self, *exc_info) -> bool:
        return False


@unittest.skipUnless(FireShareClient is not None, "aiohttp is not installed")
class FireShareUploadPrivacyTests(unittest.IsolatedAsyncioTestCase):
    """Requirements 1 & 2: the multipart `private` field is omitted for
    server-default and carries the exact requested bool otherwise."""

    async def _upload_with(self, private, token: str = "test-token") -> tuple[list[tuple[str, object]], list[dict]]:
        with tempfile.TemporaryDirectory() as tmp:
            clip_path = Path(tmp) / "clip.mp4"
            clip_path.write_bytes(b"video-bytes")
            client = FireShareClient(base_url="https://fireshare.example.com", token=token)
            fake_form = _FakeFormData()
            fake_session = _FakeUploadSession(_FakeUploadResponse())
            with mock.patch("vice.fireshare.aiohttp.FormData", return_value=fake_form), \
                 mock.patch("vice.fireshare.aiohttp.ClientSession", return_value=fake_session):
                await client.upload(
                    clip_path=clip_path,
                    idempotency_key="idem-1",
                    title="My clip",
                    folder="",
                    private=private,
                    game_id=None,
                    tag_ids=[],
                    on_progress=lambda *_: None,
                )
            return fake_form.fields, fake_session.requested_headers

    async def test_server_default_omits_private_field(self) -> None:
        fields, _ = await self._upload_with(None)
        self.assertNotIn("private", [name for name, _ in fields])

    async def test_explicit_public_sends_false(self) -> None:
        fields, _ = await self._upload_with(False)
        self.assertIn(("private", "false"), fields)

    async def test_explicit_private_sends_true(self) -> None:
        fields, _ = await self._upload_with(True)
        self.assertIn(("private", "true"), fields)

    async def test_upload_authenticates_with_the_real_token_as_a_bearer_header(self) -> None:
        """The upload must authenticate with the caller's actual token (not a
        hardcoded placeholder), and that token must not leak anywhere besides
        this one outgoing header."""
        placeholder_token = "test-placeholder-token-67890"
        _, headers = await self._upload_with(None, token=placeholder_token)
        self.assertEqual(len(headers), 1)
        auth_header = headers[0].get("Authorization")
        expected = f"Bearer {placeholder_token}"
        self.assertEqual(auth_header, expected)
        self.assertNotEqual(auth_header, "******")


class _FakeGetSession:
    """Stand-in for aiohttp.ClientSession used by get_status()/validate()."""

    def __init__(self, response: _FakeUploadResponse) -> None:
        self._response = response
        self.requested_headers: list[dict] = []

    def get(self, url, headers=None):
        self.requested_headers.append(dict(headers or {}))
        return self._response

    async def __aenter__(self) -> "_FakeGetSession":
        return self

    async def __aexit__(self, *exc_info) -> bool:
        return False


@unittest.skipUnless(FireShareClient is not None, "aiohttp is not installed")
class FireShareGetStatusHeaderTests(unittest.IsolatedAsyncioTestCase):
    async def test_get_status_authenticates_with_the_real_token_as_a_bearer_header(self) -> None:
        placeholder_token = "test-placeholder-token-status"
        client = FireShareClient(base_url="https://fireshare.example.com", token=placeholder_token)
        fake_session = _FakeGetSession(
            _FakeUploadResponse(status=200, payload={"job_id": "job-1", "status": "ready", "private": False})
        )
        with mock.patch("vice.fireshare.aiohttp.ClientSession", return_value=fake_session):
            await client.get_status("job-1")

        self.assertEqual(len(fake_session.requested_headers), 1)
        auth_header = fake_session.requested_headers[0].get("Authorization")
        expected = f"Bearer {placeholder_token}"
        self.assertEqual(auth_header, expected)
        self.assertNotEqual(auth_header, "******")




# ---------------------------------------------------------------------------
# Manager-level tests: effective-vs-requested persistence and retry safety
# ---------------------------------------------------------------------------

class _FakeManagerClient:
    """Stand-in for FireShareClient used by FireSharePublishManager, with a
    scripted upload() result (either a (status, envelope, retry_after,
    source_sha256) tuple or an exception instance to raise)."""

    def __init__(self, upload_result=None) -> None:
        self._upload_result = upload_result

    async def upload(self, **_kwargs):
        if isinstance(self._upload_result, Exception):
            raise self._upload_result
        return self._upload_result

    async def get_status(self, job_id):  # pragma: no cover - not exercised here
        raise AssertionError("get_status should not be called in this test")


@unittest.skipUnless(FireShareClient is not None, "aiohttp is not installed")
class FireSharePublishManagerPrivacyTests(unittest.IsolatedAsyncioTestCase):
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

    async def _publish_and_wait(self, private, fake_client: _FakeManagerClient) -> str:
        with mock.patch("vice.fireshare.FireShareClient", return_value=fake_client):
            state = await self.manager.publish(
                slug="Clip_1",
                base_url="https://fireshare.example.com",
                token="tok",
                options={"private": private},
            )
            attempt_id = state["attempt_id"]
            task = self.manager._tasks.get(attempt_id)
            if task:
                await task
        return attempt_id

    async def test_effective_privacy_persisted_independently_of_requested(self) -> None:
        """Requirement 3: FireShare's effective privacy is stored/exposed
        separately from what we requested, even when we requested
        server-default (None)."""
        envelope = FireShareJobEnvelope(
            job_id="job-1", video_id="vid-1",
            public_url="https://fireshare.example.com/v/1", path=None,
            status="ready", private=True, title="My clip", deduplicated=False,
            error=None, created_at=None, updated_at=None,
        )
        fake_client = _FakeManagerClient(upload_result=(202, envelope, 2, "fakehash-1"))
        attempt_id = await self._publish_and_wait(None, fake_client)

        raw = self.library.get_fireshare_attempt(attempt_id)
        self.assertIsNone(raw["private"])                 # requested: server-default
        self.assertEqual(raw["effective_private"], 1)      # effective: FireShare made it private

        pub = self.manager.get_clip_publication(self.clip_uuid)
        self.assertIsNone(pub["current"]["requested_private"])
        self.assertIs(pub["current"]["effective_private"], True)

    async def test_effective_privacy_not_erased_by_field_omitting_poll(self) -> None:
        """A later merge that omits `private` (e.g. a poll response) must not
        clobber a previously-learned effective value."""
        first = FireShareJobEnvelope(
            job_id="job-2", video_id=None, public_url=None, path=None,
            status="ready", private=False, title=None, deduplicated=False,
            error=None, created_at=None, updated_at=None,
        )
        fake_client = _FakeManagerClient(upload_result=(202, first, 2, "fakehash-2"))
        with mock.patch("vice.fireshare.FireShareClient", return_value=fake_client):
            state = await self.manager.publish(
                slug="Clip_1", base_url="https://fireshare.example.com", token="tok",
                options={"private": None},
            )
            attempt_id = state["attempt_id"]
            task = self.manager._tasks.get(attempt_id)
            if task:
                await task

        # Simulate a later poll response that carries no `private` field at all.
        second = FireShareJobEnvelope(
            job_id="job-2", video_id="vid-2", public_url="https://fireshare.example.com/v/2",
            path=None, status="ready", private=None, title=None, deduplicated=False,
            error=None, created_at=None, updated_at=None,
        )
        await self.manager._merge_remote_envelope(
            attempt_id, "Clip_1", self.clip_uuid,
            status_code=200, envelope=second, retry_after=2, polled=True,
        )
        raw = self.library.get_fireshare_attempt(attempt_id)
        self.assertEqual(raw["effective_private"], 0)  # sticky from the first response

    async def test_retry_preserves_original_nullable_requested_privacy(self) -> None:
        """Requirement 4 / regression for the `bool(attempt.get("private"))`
        bug: retrying a server-default attempt must not turn it into an
        explicit "public" (False) request."""
        fake_client = _FakeManagerClient(
            upload_result=FireShareError("network_error", "boom", status=None)
        )
        attempt_id = await self._publish_and_wait(None, fake_client)
        first = self.library.get_fireshare_attempt(attempt_id)
        self.assertEqual(first["state"], "retryable_ambiguous")
        self.assertIsNone(first["private"])

        retry_envelope = FireShareJobEnvelope(
            job_id="job-3", video_id="vid-3", public_url="https://fireshare.example.com/v/3",
            path=None, status="ready", private=True, title=None, deduplicated=False,
            error=None, created_at=None, updated_at=None,
        )
        retry_client = _FakeManagerClient(upload_result=(202, retry_envelope, 2, "fakehash-3"))
        with mock.patch("vice.fireshare.FireShareClient", return_value=retry_client):
            state = await self.manager.retry(
                attempt_id=attempt_id, base_url="https://fireshare.example.com", token="tok",
            )
            self.assertIsNone(state["requested_private"])
            task = self.manager._tasks.get(attempt_id)
            if task:
                await task

        retried = self.library.get_fireshare_attempt(attempt_id)
        self.assertIsNone(retried["private"])  # still server-default, never coerced to False
        self.assertEqual(retried["effective_private"], 1)

    async def test_retry_preserves_explicit_requested_privacy(self) -> None:
        """The same retry path must also leave an explicit True/False alone."""
        fake_client = _FakeManagerClient(
            upload_result=FireShareError("network_error", "boom", status=None)
        )
        attempt_id = await self._publish_and_wait(True, fake_client)
        first = self.library.get_fireshare_attempt(attempt_id)
        self.assertEqual(first["private"], 1)

        retry_envelope = FireShareJobEnvelope(
            job_id="job-4", video_id="vid-4", public_url="https://fireshare.example.com/v/4",
            path=None, status="ready", private=True, title=None, deduplicated=False,
            error=None, created_at=None, updated_at=None,
        )
        retry_client = _FakeManagerClient(upload_result=(202, retry_envelope, 2, "fakehash-4"))
        with mock.patch("vice.fireshare.FireShareClient", return_value=retry_client):
            await self.manager.retry(
                attempt_id=attempt_id, base_url="https://fireshare.example.com", token="tok",
            )
            task = self.manager._tasks.get(attempt_id)
            if task:
                await task

        retried = self.library.get_fireshare_attempt(attempt_id)
        self.assertEqual(retried["private"], 1)  # unchanged: still an explicit "private"


# ---------------------------------------------------------------------------
# Attempt-integrity tests: bounded-memory SHA-256 hashing at upload time and
# retry-time verification that on-disk bytes still match what was uploaded.
# ---------------------------------------------------------------------------

@unittest.skipUnless(FireShareClient is not None, "aiohttp is not installed")
class FireShareUploadSourceHashTests(unittest.IsolatedAsyncioTestCase):
    """The client computes `source_sha256` from the exact bytes it streamed,
    without ever holding more than one chunk in memory, and preserves that
    digest even when FireShare's response is an error (the whole body is
    already on the wire by the time the status/response come back)."""

    async def _upload(self, content: bytes, *, response_status: int = 202):
        with tempfile.TemporaryDirectory() as tmp:
            clip_path = Path(tmp) / "clip.mp4"
            clip_path.write_bytes(content)
            client = FireShareClient(base_url="https://fireshare.example.com", token="test-token")
            fake_form = _FakeFormData()
            payload = {"job_id": "job-1", "status": "accepted"}
            if response_status >= 400:
                payload = {"error": {"code": "server_error", "message": "boom"}}
            fake_session = _FakeUploadSession(_FakeUploadResponse(status=response_status, payload=payload))
            with mock.patch("vice.fireshare.aiohttp.FormData", return_value=fake_form), \
                 mock.patch("vice.fireshare.aiohttp.ClientSession", return_value=fake_session):
                kwargs = dict(
                    clip_path=clip_path,
                    idempotency_key="idem-1",
                    title="t",
                    folder="",
                    private=None,
                    game_id=None,
                    tag_ids=[],
                    on_progress=lambda *_: None,
                )
                if response_status >= 400:
                    with self.assertRaises(FireShareError) as ctx:
                        await client.upload(**kwargs)
                    return ctx.exception.source_sha256
                _, _, _, source_sha256 = await client.upload(**kwargs)
                return source_sha256

    async def test_upload_returns_the_exact_sha256_of_the_bytes_sent(self) -> None:
        # Large enough, and read in 4096-byte simulated chunks (see
        # _FakeUploadSession.post), to exercise multiple incremental
        # hasher.update() calls rather than a single whole-file read.
        content = (b"video-bytes-chunk-" * 2000)
        source_sha256 = await self._upload(content)
        self.assertEqual(source_sha256, hashlib.sha256(content).hexdigest())

    async def test_upload_preserves_sha256_even_when_the_server_rejects_it(self) -> None:
        content = b"rejected-clip-bytes"
        source_sha256 = await self._upload(content, response_status=400)
        self.assertEqual(source_sha256, hashlib.sha256(content).hexdigest())

    async def test_sha256_is_none_when_the_file_is_never_fully_read(self) -> None:
        """A network layer that never drains the file (e.g. the connection
        died before the body was fully sent) must not report a digest for
        bytes that were never actually streamed."""

        class _NonDrainingSession:
            def post(self, url, data=None, headers=None):
                return _FakeUploadResponse()

            async def __aenter__(self) -> "_NonDrainingSession":
                return self

            async def __aexit__(self, *exc_info) -> bool:
                return False

        with tempfile.TemporaryDirectory() as tmp:
            clip_path = Path(tmp) / "clip.mp4"
            clip_path.write_bytes(b"partial-bytes")
            client = FireShareClient(base_url="https://fireshare.example.com", token="test-token")
            fake_form = _FakeFormData()
            with mock.patch("vice.fireshare.aiohttp.FormData", return_value=fake_form), \
                 mock.patch("vice.fireshare.aiohttp.ClientSession", return_value=_NonDrainingSession()):
                _, _, _, source_sha256 = await client.upload(
                    clip_path=clip_path,
                    idempotency_key="idem-1",
                    title="t",
                    folder="",
                    private=None,
                    game_id=None,
                    tag_ids=[],
                    on_progress=lambda *_: None,
                )
            self.assertIsNone(source_sha256)


class FireShareHashFileBoundedMemoryTests(unittest.IsolatedAsyncioTestCase):
    """`_hash_file_sha256` (used by retry() to re-verify on-disk bytes) must
    assemble the correct digest across chunk boundaries while never reading
    more than `chunk_size` bytes into memory at once."""

    async def test_matches_whole_file_digest_across_multiple_small_chunks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "clip.mp4"
            # Deterministic, non-repeating-byte content spanning many
            # boundaries at a deliberately tiny chunk size.
            content = bytes((i * 37 + 11) % 256 for i in range(50_000))
            path.write_bytes(content)

            digest = _hash_file_sha256(path, chunk_size=777)  # awkward size on purpose

            self.assertEqual(digest, hashlib.sha256(content).hexdigest())

    async def test_bounded_memory_reads_never_exceed_chunk_size(self) -> None:
        """Directly asserts the streaming contract: every read() the hasher
        issues against the file handle is capped at chunk_size, so memory
        use stays flat regardless of clip length."""
        seen_sizes: list[int] = []
        real_open = Path.open

        class _WatchedFile:
            def __init__(self, fh) -> None:
                self._fh = fh

            def read(self, n=-1):
                seen_sizes.append(n)
                return self._fh.read(n)

            def __enter__(self) -> "_WatchedFile":
                return self

            def __exit__(self, *exc_info) -> bool:
                self._fh.close()
                return False

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "clip.mp4"
            path.write_bytes(b"x" * 10_000)

            def fake_open(self, mode="rb"):
                return _WatchedFile(real_open(self, mode))

            with mock.patch.object(Path, "open", fake_open):
                _hash_file_sha256(path, chunk_size=1000)

            self.assertTrue(seen_sizes)
            self.assertTrue(all(size == 1000 for size in seen_sizes[:-1]))
            self.assertLessEqual(seen_sizes[-1], 1000)


@unittest.skipUnless(FireShareClient is not None, "aiohttp is not installed")
class FireShareRetryHashIntegrityTests(unittest.IsolatedAsyncioTestCase):
    """End-to-end (real FireShareClient, mocked network) coverage of the
    retry-time contract: before reusing the same idempotency key, current
    bytes must match the stored SHA-256 when one is available. A mismatch
    must refuse the retry rather than silently mutating the immutable
    attempt; legacy attempts with no stored hash keep the old stat-only
    behavior."""

    async def asyncSetUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        root = Path(self._tmp.name)

        self.library = ClipLibrary(root / "library.sqlite3")
        self.addCleanup(self.library.close)
        self.clip_uuid = self.library.catalog_clip(ObservedFile(slug="Clip_1", size=10, mtime_ns=1))

        self.clip_path = root / "Clip_1.mp4"
        self.original_bytes = b"original-clip-bytes-0123456789"
        self.clip_path.write_bytes(self.original_bytes)

        async def broadcast(msg: dict) -> None:
            return None

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

    async def _publish_with_real_client_and_fail(self) -> str:
        """A real (network-mocked) upload that fully streams+hashes
        `self.original_bytes`, then fails with a server error (still a
        retryable state) so retry() has something to act on."""
        fake_form = _FakeFormData()
        fake_session = _FakeUploadSession(
            _FakeUploadResponse(status=500, payload={"error": {"code": "server_error", "message": "boom"}})
        )
        with mock.patch("vice.fireshare.aiohttp.FormData", return_value=fake_form), \
             mock.patch("vice.fireshare.aiohttp.ClientSession", return_value=fake_session):
            state = await self.manager.publish(
                slug="Clip_1", base_url="https://fireshare.example.com", token="tok",
                options={"private": None},
            )
            attempt_id = state["attempt_id"]
            task = self.manager._tasks.get(attempt_id)
            if task:
                await task
        return attempt_id

    async def test_hash_is_persisted_after_a_failed_but_fully_uploaded_attempt(self) -> None:
        attempt_id = await self._publish_with_real_client_and_fail()
        attempt = self.library.get_fireshare_attempt(attempt_id)
        self.assertEqual(attempt["state"], "failed")
        self.assertEqual(attempt["source_sha256"], hashlib.sha256(self.original_bytes).hexdigest())

    async def test_retry_with_unchanged_bytes_succeeds(self) -> None:
        attempt_id = await self._publish_with_real_client_and_fail()

        retry_form = _FakeFormData()
        retry_session = _FakeUploadSession(
            _FakeUploadResponse(
                status=202,
                payload={
                    "job_id": "job-ready",
                    "status": "ready",
                    "video_id": "vid-ready",
                    "public_url": "https://fireshare.example.com/v/ready",
                },
            )
        )
        with mock.patch("vice.fireshare.aiohttp.FormData", return_value=retry_form), \
             mock.patch("vice.fireshare.aiohttp.ClientSession", return_value=retry_session):
            state = await self.manager.retry(
                attempt_id=attempt_id, base_url="https://fireshare.example.com", token="tok",
            )
            task = self.manager._tasks.get(attempt_id)
            if task:
                await task

        self.assertEqual(state["attempt_id"], attempt_id)
        retried = self.library.get_fireshare_attempt(attempt_id)
        self.assertEqual(retried["state"], "ready")
        # The immutable attempt's hash is unchanged (it's the same file).
        self.assertEqual(retried["source_sha256"], hashlib.sha256(self.original_bytes).hexdigest())

    async def test_retry_rejects_changed_bytes_even_with_preserved_size_and_mtime(self) -> None:
        attempt_id = await self._publish_with_real_client_and_fail()
        attempt = self.library.get_fireshare_attempt(attempt_id)
        original_mtime_ns = attempt["source_mtime_ns"]

        # Same length (so the cheap stat snapshot still matches), different
        # content — simulates a rewritten/corrupted file with a forced or
        # clock-skewed mtime restored to its original value.
        tampered = bytes((b + 1) % 256 for b in self.original_bytes)
        self.assertEqual(len(tampered), len(self.original_bytes))
        self.assertNotEqual(tampered, self.original_bytes)
        self.clip_path.write_bytes(tampered)
        os.utime(self.clip_path, ns=(original_mtime_ns, original_mtime_ns))

        # Sanity: the cheap stat snapshot alone would NOT catch this.
        st = self.clip_path.stat()
        self.assertEqual(st.st_size, attempt["source_size"])
        self.assertEqual(st.st_mtime_ns, original_mtime_ns)

        with self.assertRaises(FireShareError) as ctx:
            await self.manager.retry(
                attempt_id=attempt_id, base_url="https://fireshare.example.com", token="tok",
            )
        self.assertEqual(ctx.exception.code, "source_changed")

        # The rejected retry must not have mutated the immutable attempt.
        unchanged = self.library.get_fireshare_attempt(attempt_id)
        self.assertEqual(unchanged["state"], "failed")
        self.assertEqual(unchanged["source_sha256"], hashlib.sha256(self.original_bytes).hexdigest())
        self.assertNotIn(attempt_id, self.manager._tasks)

    async def test_retry_of_legacy_attempt_with_no_stored_hash_uses_stat_only(self) -> None:
        """Requirement 6-adjacent: pre-upgrade rows have `source_sha256 IS
        NULL`. Retry must not require or attempt to compute a hash
        comparison for these — the original stat-only guard keeps working
        exactly as before."""
        attempt_id = "legacy-attempt-1"
        st = self.clip_path.stat()
        self.library.save_fireshare_attempt(
            {
                "attempt_id": attempt_id,
                "clip_uuid": self.clip_uuid,
                "idempotency_key": attempt_id,
                "source_device": getattr(st, "st_dev", None),
                "source_inode": getattr(st, "st_ino", None),
                "source_size": st.st_size,
                "source_mtime_ns": st.st_mtime_ns,
                "source_sha256": None,
                "title": "",
                "folder": "",
                "private": None,
                "effective_private": None,
                "game_id": None,
                "tag_ids_json": "[]",
                "state": "failed",
                "error_code": "network_error",
                "error_message": "boom",
            }
        )
        self.library.set_fireshare_current(self.clip_uuid, current_attempt_id=attempt_id)

        retry_form = _FakeFormData()
        retry_session = _FakeUploadSession(
            _FakeUploadResponse(
                status=202,
                payload={"job_id": "job-legacy", "status": "ready", "video_id": "vid-legacy"},
            )
        )
        with mock.patch("vice.fireshare.aiohttp.FormData", return_value=retry_form), \
             mock.patch("vice.fireshare.aiohttp.ClientSession", return_value=retry_session):
            await self.manager.retry(
                attempt_id=attempt_id, base_url="https://fireshare.example.com", token="tok",
            )
            task = self.manager._tasks.get(attempt_id)
            if task:
                await task

        retried = self.library.get_fireshare_attempt(attempt_id)
        self.assertEqual(retried["state"], "ready")
        # The retry's real upload now records a hash going forward, even
        # though the original legacy attempt never had one.
        self.assertEqual(retried["source_sha256"], hashlib.sha256(self.original_bytes).hexdigest())


# ---------------------------------------------------------------------------
# Config: tri-state values and legacy-boolean migration safety
# ---------------------------------------------------------------------------

class FireSharePrivacyConfigHelperTests(unittest.TestCase):
    def test_privacy_values_are_exactly_the_tri_state(self) -> None:
        self.assertEqual(FIRESHARE_PRIVACY_VALUES, {"server_default", "public", "private"})

    def test_to_bool_roundtrips(self) -> None:
        self.assertIsNone(fireshare_privacy_to_bool("server_default"))
        self.assertEqual(fireshare_privacy_to_bool("public"), False)
        self.assertEqual(fireshare_privacy_to_bool("private"), True)

    def test_from_bool_roundtrips(self) -> None:
        self.assertEqual(fireshare_privacy_from_bool(None), "server_default")
        self.assertEqual(fireshare_privacy_from_bool(False), "public")
        self.assertEqual(fireshare_privacy_from_bool(True), "private")


class FireShareConfigLegacyMigrationTests(unittest.TestCase):
    """Requirement 6: an upgraded config with only the old boolean
    ``default_private`` (no distinct explicit-choice marker) must migrate to
    ``server_default`` — never silently reinterpreted as "public" (the old
    default) nor "private"."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.config_path = Path(self._tmp.name) / "config.toml"

    def _load_with_raw_toml(self, toml_text: str):
        from vice import config as config_module

        self.config_path.write_text(toml_text, encoding="utf-8")
        with mock.patch.object(config_module, "CONFIG_PATH", self.config_path):
            return config_module.load()

    def test_legacy_default_private_false_migrates_to_server_default(self) -> None:
        cfg = self._load_with_raw_toml("[fireshare]\ndefault_private = false\n")
        self.assertEqual(cfg.fireshare.default_privacy, "server_default")
        self.assertFalse(hasattr(cfg.fireshare, "default_private"))

    def test_legacy_default_private_true_also_migrates_to_server_default(self) -> None:
        """A legacy `true` isn't "more intentional" than `false` either — there
        is still no explicit-choice marker, so it must not be read as
        "private"."""
        cfg = self._load_with_raw_toml("[fireshare]\ndefault_private = true\n")
        self.assertEqual(cfg.fireshare.default_privacy, "server_default")

    def test_no_fireshare_section_defaults_to_server_default(self) -> None:
        cfg = self._load_with_raw_toml("")
        self.assertEqual(cfg.fireshare.default_privacy, "server_default")

    def test_explicit_default_privacy_is_honored(self) -> None:
        cfg = self._load_with_raw_toml("[fireshare]\ndefault_privacy = \"private\"\n")
        self.assertEqual(cfg.fireshare.default_privacy, "private")

    def test_invalid_default_privacy_falls_back_to_server_default(self) -> None:
        cfg = self._load_with_raw_toml("[fireshare]\ndefault_privacy = \"nonsense\"\n")
        self.assertEqual(cfg.fireshare.default_privacy, "server_default")


if __name__ == "__main__":
    unittest.main()
