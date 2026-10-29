"""Behavior where upstream 2.15 features meet the fork's catalogue and exports."""

import asyncio
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

from vice.config import Config, OutputConfig, RecordingConfig
from vice.editor import Source, build_export_cmd, discord_bitrates, validate_project
from vice.recorder import GSRRecorder
from vice.share import ShareServer


class TrimCatalogueIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        patcher = mock.patch("vice.share.LIBRARY_PATH", root / "library.sqlite3")
        patcher.start()
        self.addCleanup(patcher.stop)
        self.server = ShareServer(Config(output=OutputConfig(directory=str(root), auto_playlist_by_game=False)))
        self.source = root / "Session.mp4"
        self.source.write_bytes(b"original session recording")
        self.server._clips = {"Session": self.source}
        self.server._init_library()
        self.addCleanup(self.server.library.close)
        self.uuid = self.server._clip_uuid("Session")
        self.server.library.set_game(self.uuid, "A manually assigned game")
        self.server.library.set_origin(self.uuid, "edited")
        self.playlist = self.server.library.create_custom_playlist("Favorites")["id"]
        self.server.library.set_memberships(self.uuid, [self.playlist])

    async def trim(self, copy):
        req = SimpleNamespace(match_info={"slug": "Session"}, json=mock.AsyncMock(
            return_value={"start": 1, "end": 3, "copy": copy}))

        async def spawn(*cmd, **_):
            Path(cmd[-1]).write_bytes(b"trimmed recording")
            return SimpleNamespace(returncode=0)

        with mock.patch("vice.share.asyncio.create_subprocess_exec", side_effect=spawn), \
             mock.patch("vice.share.communicate_with_timeout", return_value=(b"", b"")), \
             mock.patch("vice.share._trim_result_problem", return_value=""), \
             mock.patch.object(self.server, "_get_meta", return_value={"vcodec": "h264"}), \
             mock.patch.object(self.server, "_broadcast_clip"), \
             mock.patch.object(self.server, "broadcast"):
            response = await self.server._api_trim(req)
            await asyncio.sleep(0)
        return json.loads(response.text)

    async def test_trim_copy_has_new_identity_and_inherits_catalogue_metadata(self):
        result = await self.trim(copy=True)
        self.assertTrue(result["ok"])
        copied = self.server._clip_uuid(result["slug"])
        self.assertNotEqual(copied, self.uuid)
        self.assertEqual(self.server._clip_uuid("Session"), self.uuid)
        self.assertEqual(self.source.read_bytes(), b"original session recording")
        row = self.server.library.get_clip(copied)
        self.assertEqual(row["game"], "A manually assigned game")
        self.assertEqual(row["origin"], "edited")
        self.assertIn(self.playlist, self.server.library.memberships_of(copied))

    async def test_replacing_trim_preserves_identity_after_catalogue_rescan(self):
        result = await self.trim(copy=False)
        self.assertTrue(result["ok"])
        self.server._library_resync()
        self.assertEqual(self.server._clip_uuid("Session"), self.uuid)
        row = self.server.library.get_clip(self.uuid)
        self.assertEqual(row["game"], "A manually assigned game")
        self.assertEqual(row["origin"], "edited")
        self.assertIn(self.playlist, self.server.library.memberships_of(self.uuid))


class ExportIntegrationTests(unittest.TestCase):
    def test_discord_size_budget_is_used_with_each_export_encoder(self):
        sources = {"clip": Source(Path("/tmp/clip.mp4"), 30, 1920, 1080, True)}
        project, errors = validate_project({"version": 1, "tracks": [
            {"id": "T1", "type": "text"}, {"id": "V1", "type": "video"}],
            "items": [{"id": "clip", "kind": "clip", "clipId": "clip", "trackId": "V1",
                       "start": 0, "offset": 0, "dur": 30}], "fps": 30}, sources)
        self.assertEqual(errors, [])
        video_kbps, audio_kbps = discord_bitrates(30)
        for encoder in ("libx264", "h264_nvenc", "h264_vaapi"):
            with self.subTest(encoder=encoder):
                cmd = build_export_cmd(project, sources, Path("/tmp/export.mp4"),
                                       discord_optimized=True, video_encoder=encoder,
                                       video_device="/dev/dri/renderD128" if encoder.endswith("vaapi") else None)
                self.assertEqual(cmd[cmd.index("-c:v") + 1], encoder)
                self.assertEqual(cmd[cmd.index("-b:v") + 1], f"{video_kbps}k")
                self.assertEqual(cmd[cmd.index("-b:a") + 1], f"{audio_kbps}k")
                self.assertEqual(cmd[cmd.index("-r") + 1], "30")
                self.assertNotIn("-crf", cmd)


class SessionTrackIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_session_track_gains_run_before_the_saved_notification(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "session.mp4"
            path.touch()
            recorder = GSRRecorder(Config(recording=RecordingConfig(
                capture_microphone=True, audio_tracks=["default_output"],
                audio_track_volumes={"default_output": 0.5})))
            recorder._session_active = True
            recorder._session_path = path
            recorder._session_proc = SimpleNamespace(stderr=None)
            recorder._session_program = "gpu-screen-recorder"
            calls = []

            async def gains(*_):
                calls.append("gains")

            recorder.on_clip_saved(lambda _: calls.append("saved"))
            with mock.patch("vice.recorder._terminate_group"), \
                 mock.patch("vice.recorder._read_stream_text", return_value=""), \
                 mock.patch("vice.recorder._apply_track_volumes", side_effect=gains):
                await recorder.stop_session()
            self.assertEqual(calls, ["gains", "saved"])


class ConfigIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_failed_live_apply_restores_overlay_and_fork_settings(self):
        server = ShareServer(Config())
        server.cfg.sharing.prefer_fireshare_link = True
        server.apply_config_cb = mock.AsyncMock(side_effect=[RuntimeError("apply failed"), None])
        request = SimpleNamespace(json=mock.AsyncMock(return_value={
            "overlay": {"keys": True}, "sharing": {"share_discord_file": True}}))
        with mock.patch("vice.config.load", return_value=server.cfg), \
             mock.patch("vice.config.save") as save:
            response = await server._api_set_config(request)
        body = json.loads(response.text)
        self.assertFalse(body["applied"])
        self.assertFalse(server.cfg.overlay.keys)
        self.assertTrue(server.cfg.sharing.prefer_fireshare_link)
        self.assertFalse(server.cfg.sharing.share_discord_file)
        saved = save.call_args.args[0]
        self.assertTrue(saved.overlay.keys)
        self.assertTrue(saved.sharing.prefer_fireshare_link)
        self.assertTrue(saved.sharing.share_discord_file)
