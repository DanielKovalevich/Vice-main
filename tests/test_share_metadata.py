"""Tests for the transactional clip-metadata endpoint (Phase 3, item 9).

``POST /api/clips/{slug}/metadata`` saves a clip's canonical game, raw/edited
type, and custom playlist memberships in one request and returns the
authoritative updated clip + playlists so the UI can apply them immediately.
These drive the handler directly with a stub request (no aiohttp server, ports,
ffmpeg, or thumbnails).
"""

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from vice.config import Config, OutputConfig, SharingConfig

try:
    from aiohttp import web
    from vice.share import ShareServer
    from vice.library import ORIGIN_RAW, ORIGIN_EDITED
except ModuleNotFoundError:  # pragma: no cover - aiohttp missing
    web = None
    ShareServer = None
    ORIGIN_RAW, ORIGIN_EDITED = "raw", "edited"


class _Req:
    def __init__(self, match: dict, body) -> None:
        self.match_info = match
        self._body = body

    async def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


def _payload(resp) -> dict:
    return json.loads(resp.body.decode())


@unittest.skipUnless(ShareServer is not None, "aiohttp is not installed")
class ShareServerMetadataTests(unittest.IsolatedAsyncioTestCase):
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
            output=OutputConfig(directory=str(self.output_dir),
                                auto_playlist_by_game=True),
            sharing=SharingConfig(port=0, public_port=0, cloudflare_tunnel=False),
        )
        self.server = ShareServer(cfg)
        self.server._clips = {}
        self.addCleanup(self._close_library)

    def _close_library(self) -> None:
        if self.server.library is not None:
            self.server.library.close()

    def _make_clip(self, slug: str) -> Path:
        path = self.output_dir / f"{slug}.mp4"
        path.write_bytes(b"not-a-real-mp4")
        self.server._clips[slug] = path
        return path

    async def _save(self, slug: str, body) -> dict:
        resp = await self.server._api_set_metadata(_Req({"slug": slug}, body))
        return _payload(resp)

    def _auto_playlist(self, key: str):
        return self.server.playlists.get(f"auto:{key}")

    # ── game ──────────────────────────────────────────────────────────────────

    async def test_set_game_returns_authoritative_clip_and_syncs_auto(self) -> None:
        self._make_clip("Vice_Clip_1")
        self.server._init_library()

        data = await self._save("Vice_Clip_1", {"game": "Halo"})
        self.assertTrue(data["ok"])
        self.assertEqual(data["clip"]["game"], "Halo")
        # Auto playlist appears in the returned playlists and contains the clip.
        halo = self._auto_playlist("halo")
        self.assertIsNotNone(halo)
        self.assertIn("Vice_Clip_1", halo["clip_slugs"])
        self.assertTrue(any(p["id"] == "auto:halo" for p in data["playlists"]))

    async def test_changing_game_moves_between_auto_playlists(self) -> None:
        self._make_clip("Vice_Clip_1")
        self.server._init_library()
        await self._save("Vice_Clip_1", {"game": "Halo"})

        await self._save("Vice_Clip_1", {"game": "Doom"})
        self.assertIsNone(self._auto_playlist("halo"))  # emptied + pruned
        doom = self._auto_playlist("doom")
        self.assertIsNotNone(doom)
        self.assertIn("Vice_Clip_1", doom["clip_slugs"])

    async def test_clearing_game_removes_from_auto_playlist(self) -> None:
        self._make_clip("Vice_Clip_1")
        self.server._init_library()
        await self._save("Vice_Clip_1", {"game": "Halo"})

        data = await self._save("Vice_Clip_1", {"game": ""})
        self.assertIsNone(data["clip"]["game"])
        self.assertIsNone(self._auto_playlist("halo"))

    # ── origin (raw/edited) ────────────────────────────────────────────────────

    async def test_set_origin_roundtrips(self) -> None:
        self._make_clip("Vice_Clip_1")
        self.server._init_library()

        data = await self._save("Vice_Clip_1", {"origin": "edited"})
        self.assertEqual(data["clip"]["origin"], ORIGIN_EDITED)
        data = await self._save("Vice_Clip_1", {"origin": "raw"})
        self.assertEqual(data["clip"]["origin"], ORIGIN_RAW)

    async def test_invalid_origin_is_rejected(self) -> None:
        self._make_clip("Vice_Clip_1")
        self.server._init_library()
        resp = await self.server._api_set_metadata(
            _Req({"slug": "Vice_Clip_1"}, {"origin": "bogus"}))
        self.assertEqual(resp.status, 400)
        self.assertFalse(_payload(resp)["ok"])

    # ── custom playlist checklist ──────────────────────────────────────────────

    async def test_custom_membership_matches_checklist(self) -> None:
        self._make_clip("Vice_Clip_1")
        self.server._init_library()
        p1 = self.server.playlists.create_custom("Faves")["id"]
        p2 = self.server.playlists.create_custom("Clips")["id"]

        await self._save("Vice_Clip_1", {"playlist_ids": [p1]})
        self.assertIn("Vice_Clip_1", self.server.playlists.get(p1)["clip_slugs"])
        self.assertNotIn("Vice_Clip_1", self.server.playlists.get(p2)["clip_slugs"])

        # Switch membership to p2 only.
        data = await self._save("Vice_Clip_1", {"playlist_ids": [p2]})
        self.assertNotIn("Vice_Clip_1", self.server.playlists.get(p1)["clip_slugs"])
        self.assertIn("Vice_Clip_1", self.server.playlists.get(p2)["clip_slugs"])
        self.assertTrue(data["ok"])

        # Clear membership entirely.
        await self._save("Vice_Clip_1", {"playlist_ids": []})
        self.assertNotIn("Vice_Clip_1", self.server.playlists.get(p2)["clip_slugs"])

    async def test_unknown_playlist_is_rejected(self) -> None:
        self._make_clip("Vice_Clip_1")
        self.server._init_library()
        resp = await self.server._api_set_metadata(
            _Req({"slug": "Vice_Clip_1"}, {"playlist_ids": ["pl-nope"]}))
        self.assertEqual(resp.status, 400)

    async def test_auto_playlist_id_cannot_be_set_via_checklist(self) -> None:
        # The checklist only manages custom playlists; passing an auto id is a
        # 400 rather than silently editing a derived view.
        self._make_clip("Vice_Clip_1")
        self.server._init_library()
        await self._save("Vice_Clip_1", {"game": "Halo"})
        resp = await self.server._api_set_metadata(
            _Req({"slug": "Vice_Clip_1"}, {"playlist_ids": ["auto:halo"]}))
        self.assertEqual(resp.status, 400)

    # ── combined + guards ──────────────────────────────────────────────────────

    async def test_combined_update_is_applied_together(self) -> None:
        self._make_clip("Vice_Clip_1")
        self.server._init_library()
        p1 = self.server.playlists.create_custom("Faves")["id"]

        data = await self._save("Vice_Clip_1", {
            "game": "Halo", "origin": "edited", "playlist_ids": [p1]})
        self.assertEqual(data["clip"]["game"], "Halo")
        self.assertEqual(data["clip"]["origin"], ORIGIN_EDITED)
        self.assertIn("Vice_Clip_1", self.server.playlists.get(p1)["clip_slugs"])
        self.assertIsNotNone(self._auto_playlist("halo"))

    async def test_unknown_clip_is_404(self) -> None:
        self.server._init_library()
        with self.assertRaises(web.HTTPNotFound):
            await self.server._api_set_metadata(
                _Req({"slug": "ghost"}, {"game": "Halo"}))


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
