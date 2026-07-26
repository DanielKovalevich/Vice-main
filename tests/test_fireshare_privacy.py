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

import json
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

    def post(self, url, data=None, headers=None):
        return self._response

    async def __aenter__(self) -> "_FakeUploadSession":
        return self

    async def __aexit__(self, *exc_info) -> bool:
        return False


@unittest.skipUnless(FireShareClient is not None, "aiohttp is not installed")
class FireShareUploadPrivacyTests(unittest.IsolatedAsyncioTestCase):
    """Requirements 1 & 2: the multipart `private` field is omitted for
    server-default and carries the exact requested bool otherwise."""

    async def _upload_with(self, private) -> list[tuple[str, object]]:
        with tempfile.TemporaryDirectory() as tmp:
            clip_path = Path(tmp) / "clip.mp4"
            clip_path.write_bytes(b"video-bytes")
            client = FireShareClient(base_url="https://fireshare.example.com", token="test-token")
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
            return fake_form.fields

    async def test_server_default_omits_private_field(self) -> None:
        fields = await self._upload_with(None)
        self.assertNotIn("private", [name for name, _ in fields])

    async def test_explicit_public_sends_false(self) -> None:
        fields = await self._upload_with(False)
        self.assertIn(("private", "false"), fields)

    async def test_explicit_private_sends_true(self) -> None:
        fields = await self._upload_with(True)
        self.assertIn(("private", "true"), fields)


# ---------------------------------------------------------------------------
# Manager-level tests: effective-vs-requested persistence and retry safety
# ---------------------------------------------------------------------------

class _FakeManagerClient:
    """Stand-in for FireShareClient used by FireSharePublishManager, with a
    scripted upload() result (either a (status, envelope, retry_after) tuple
    or an exception instance to raise)."""

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
        fake_client = _FakeManagerClient(upload_result=(202, envelope, 2))
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
        fake_client = _FakeManagerClient(upload_result=(202, first, 2))
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
        retry_client = _FakeManagerClient(upload_result=(202, retry_envelope, 2))
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
        retry_client = _FakeManagerClient(upload_result=(202, retry_envelope, 2))
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
