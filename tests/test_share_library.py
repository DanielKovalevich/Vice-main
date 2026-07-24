"""Integration tests for the additive SQLite clip catalogue wired into
:class:`vice.share.ShareServer` (Phase 2).

These exercise the server's UUID catalogue synchronisation and immutable
editor-export provenance without standing up the aiohttp HTTP server: we drive
``self._clips`` directly and call the library helper methods, so no ports,
ffmpeg, or thumbnails are involved.
"""

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from vice.config import Config, OutputConfig, SharingConfig

try:
    from vice.share import ShareServer
    from vice.library import MULTIPLE_GAMES
except ModuleNotFoundError:  # pragma: no cover - aiohttp missing
    ShareServer = None
    MULTIPLE_GAMES = "Multiple games"


@unittest.skipUnless(ShareServer is not None, "aiohttp is not installed")
class ShareServerLibraryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmpdir.cleanup)
        root = Path(self.tmpdir.name)

        self.output_dir = root / "clips"
        self.output_dir.mkdir()

        self.patchers = [
            mock.patch("vice.share._local_ip", return_value="127.0.0.1"),
            mock.patch("vice.share.THUMB_DIR", root / "thumbs"),
            mock.patch("vice.share.HIGHLIGHTS_DIR", root / "highlights"),
            mock.patch("vice.playlists.PLAYLISTS_PATH", root / "playlists.json"),
            mock.patch("vice.share.VIEWS_PATH", root / "views.json"),
            mock.patch("vice.share.LIBRARY_PATH", root / "library.sqlite3"),
        ]
        for patcher in self.patchers:
            patcher.start()
            self.addCleanup(patcher.stop)

        cfg = Config(
            output=OutputConfig(directory=str(self.output_dir)),
            sharing=SharingConfig(port=0, public_port=0, cloudflare_tunnel=False),
        )
        self.server = ShareServer(cfg)
        # We are not calling start(); make sure the catalogue starts empty and
        # is released so the Windows tempdir cleanup can remove the sqlite file.
        self.server._clips = {}
        self.addCleanup(self._close_library)

    def _close_library(self) -> None:
        if self.server.library is not None:
            self.server.library.close()

    def _make_clip(self, slug: str, data: bytes = b"not-a-real-mp4") -> Path:
        path = self.output_dir / f"{slug}.mp4"
        path.write_bytes(data)
        self.server._clips[slug] = path
        return path

    # ── catalogue identity ────────────────────────────────────────────────────

    async def test_catalogue_assigns_uuid_and_clip_json_exposes_it(self) -> None:
        path = self._make_clip("Vice_Clip_1")
        self.server._init_library()

        uuid = self.server._clip_uuid("Vice_Clip_1")
        self.assertIsNotNone(uuid)

        payload = self.server._clip_json("Vice_Clip_1", path, {})
        self.assertEqual(payload["uuid"], uuid)
        self.assertIsNone(payload["provenance"])

    async def test_external_rename_preserves_uuid(self) -> None:
        old = self._make_clip("Vice_Clip_1")
        self.server._init_library()
        uuid = self.server._clip_uuid("Vice_Clip_1")
        self.assertIsNotNone(uuid)

        # Rename on disk (same inode) as an external tool would.
        new = self.output_dir / "Renamed.mp4"
        old.rename(new)
        del self.server._clips["Vice_Clip_1"]
        self.server._clips["Renamed"] = new
        self.server._library_resync()

        self.assertEqual(self.server._clip_uuid("Renamed"), uuid)
        # Old slug still resolves to the same clip for share-link back-compat.
        self.assertEqual(self.server._clip_uuid("Vice_Clip_1"), uuid)

    async def test_reused_filename_mints_a_new_uuid(self) -> None:
        path = self._make_clip("Vice_Clip_1", b"first-file")
        self.server._init_library()
        first = self.server._clip_uuid("Vice_Clip_1")
        self.assertIsNotNone(first)

        # A brand-new file reuses the same clip number (different inode).
        path.unlink()
        path = self.output_dir / "Vice_Clip_1.mp4"
        path.write_bytes(b"second-file-different-inode")
        self.server._clips["Vice_Clip_1"] = path
        self.server._library_resync()

        second = self.server._clip_uuid("Vice_Clip_1")
        self.assertIsNotNone(second)
        self.assertNotEqual(second, first)

    async def test_delete_prunes_the_record(self) -> None:
        path = self._make_clip("Vice_Clip_1")
        self.server._init_library()
        self.assertIsNotNone(self.server._clip_uuid("Vice_Clip_1"))

        path.unlink()
        del self.server._clips["Vice_Clip_1"]
        self.server._library_resync()

        self.assertIsNone(self.server.library.get_clip_by_slug("Vice_Clip_1"))

    # ── editor-export provenance ──────────────────────────────────────────────

    def _catalogue_source(self, slug: str, game: str) -> None:
        self._make_clip(slug)
        self.server._library_resync()
        uuid = self.server.library.resolve_uuid(slug)
        self.server.library.set_game(uuid, game)

    async def test_export_provenance_infers_agreeing_game(self) -> None:
        self.server._init_library()
        self._catalogue_source("Vice_Clip_1", "Halo")
        self._catalogue_source("Vice_Clip_2", "Halo")
        self._make_clip("Vice_Edit_1")
        self.server._library_resync()

        self.server._record_export_provenance(
            "Vice_Edit_1", ["Vice_Clip_1", "Vice_Clip_2"], None)

        prov = self.server._clip_provenance("Vice_Edit_1")
        self.assertIsNotNone(prov)
        self.assertEqual(prov["game"], "Halo")
        self.assertEqual({s["slug"] for s in prov["sources"]},
                         {"Vice_Clip_1", "Vice_Clip_2"})
        self.assertEqual(self.server._clip_game("Vice_Edit_1"), "Halo")

    async def test_export_provenance_mixed_sources_are_multiple_games(self) -> None:
        self.server._init_library()
        self._catalogue_source("Vice_Clip_1", "Halo")
        self._catalogue_source("Vice_Clip_2", "Doom")
        self._make_clip("Vice_Edit_1")
        self.server._library_resync()

        self.server._record_export_provenance(
            "Vice_Edit_1", ["Vice_Clip_1", "Vice_Clip_2"], None)

        self.assertEqual(self.server._clip_provenance("Vice_Edit_1")["game"],
                         MULTIPLE_GAMES)
        self.assertEqual(self.server._clip_game("Vice_Edit_1"), MULTIPLE_GAMES)

    async def test_export_provenance_explicit_game_overrides_inference(self) -> None:
        self.server._init_library()
        self._catalogue_source("Vice_Clip_1", "Halo")
        self._catalogue_source("Vice_Clip_2", "Halo")
        self._make_clip("Vice_Edit_1")
        self.server._library_resync()

        self.server._record_export_provenance(
            "Vice_Edit_1", ["Vice_Clip_1", "Vice_Clip_2"], "Custom Montage")

        self.assertEqual(self.server._clip_provenance("Vice_Edit_1")["game"],
                         "Custom Montage")

    async def test_export_provenance_is_immutable(self) -> None:
        self.server._init_library()
        self._catalogue_source("Vice_Clip_1", "Halo")
        self._make_clip("Vice_Edit_1")
        self.server._library_resync()

        self.server._record_export_provenance("Vice_Edit_1", ["Vice_Clip_1"], "Halo")
        # A second export write for the same clip must not mutate provenance.
        self.server._record_export_provenance("Vice_Edit_1", ["Vice_Clip_1"], "Doom")

        self.assertEqual(self.server._clip_provenance("Vice_Edit_1")["game"], "Halo")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
