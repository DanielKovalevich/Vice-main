import asyncio
import json
import socket
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from vice import __version__
from vice.config import Config, HotkeyConfig, OutputConfig, RecordingConfig, SharingConfig

try:
    from aiohttp import ClientSession
    from vice.share import ShareServer
except ModuleNotFoundError:
    ClientSession = None
    ShareServer = None


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


async def _stub_ffprobe(_: Path) -> dict:
    return {"width": 1920, "height": 1080, "duration": 4.2}


class _JsonRequest:
    def __init__(self, body: dict) -> None:
        self._body = body

    async def json(self) -> dict:
        return self._body


@unittest.skipUnless(ShareServer is not None and ClientSession is not None, "aiohttp is not installed")
class ShareServerSecurityTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmpdir.cleanup)

        root = Path(self.tmpdir.name)
        self.output_dir = root / "clips"
        self.output_dir.mkdir()
        self.thumb_dir = root / "thumbs"
        self.thumb_dir.mkdir()
        self.highlights_dir = root / "highlights"
        self.highlights_dir.mkdir()

        self.clip_path = self.output_dir / "test_clip.mp4"
        self.clip_path.write_bytes(b"not-a-real-mp4")

        self.thumb_path = self.thumb_dir / "test_clip.jpg"
        self.thumb_path.write_bytes(b"jpeg")

        self.local_port = _free_port()
        self.public_port = _free_port()
        while self.public_port == self.local_port:
            self.public_port = _free_port()

        async def _stub_make_thumb(_: Path, duration: float = 0.0) -> Path:
            return self.thumb_path

        self.triggered = asyncio.Event()

        self.patchers = [
            mock.patch("vice.share._local_ip", return_value="127.0.0.1"),
            mock.patch("vice.share.THUMB_DIR", self.thumb_dir),
            mock.patch("vice.share.HIGHLIGHTS_DIR", self.highlights_dir),
            mock.patch("vice.share._ffprobe", new=_stub_ffprobe),
            mock.patch("vice.share._make_thumb", new=_stub_make_thumb),
        ]
        for patcher in self.patchers:
            patcher.start()
            self.addCleanup(patcher.stop)

        cfg = Config(
            output=OutputConfig(directory=str(self.output_dir)),
            sharing=SharingConfig(
                port=self.local_port,
                public_port=self.public_port,
                cloudflare_tunnel=False,
            ),
        )
        self.server = ShareServer(cfg)

        async def _trigger() -> None:
            self.triggered.set()

        self.server.trigger_clip_cb = _trigger
        self.server.get_status_cb = lambda: {"recording": True, "backend": "test"}

        await self.server.start()
        self.server.add_clip(self.clip_path)
        self.client = ClientSession()

    async def asyncTearDown(self) -> None:
        await self.client.close()
        await self.server.stop()

    async def test_local_control_server_exposes_ui_api_and_ws(self) -> None:
        local_base = self.server.local_base_url()
        self.assertEqual(local_base, f"http://127.0.0.1:{self.local_port}")

        async with self.client.get(f"{local_base}/api/clips") as resp:
            self.assertEqual(resp.status, 200)
            payload = await resp.json()
        self.assertEqual(payload["clips"][0]["slug"], "test_clip")
        self.assertEqual(
            payload["clips"][0]["share_url"],
            f"http://127.0.0.1:{self.public_port}/c/test_clip",
        )

        async with self.client.get(f"{local_base}/api/status") as resp:
            self.assertEqual(resp.status, 200)
            status = await resp.json()
        self.assertEqual(status["local_url"], local_base)
        self.assertEqual(status["public_url"], f"http://127.0.0.1:{self.public_port}")

        async with self.client.post(f"{local_base}/api/trigger") as resp:
            self.assertEqual(resp.status, 200)
        await asyncio.wait_for(self.triggered.wait(), timeout=1.0)

        with mock.patch(
            "vice.share.list_display_options",
            return_value={
                "backend": "gsr",
                "displays": [{"id": "DP-1", "label": "DP-1"}],
                "warning": None,
            },
        ):
            async with self.client.get(f"{local_base}/api/displays?backend=gsr") as resp:
                self.assertEqual(resp.status, 200)
                displays = await resp.json()
        self.assertEqual(displays["backend"], "gsr")
        self.assertEqual(displays["displays"][0]["id"], "DP-1")

        ws = await self.client.ws_connect(f"ws://127.0.0.1:{self.local_port}/ws")
        await ws.close()

    async def test_public_server_only_serves_share_routes(self) -> None:
        public_base = f"http://127.0.0.1:{self.public_port}"

        async with self.client.get(f"{public_base}/c/test_clip") as resp:
            self.assertEqual(resp.status, 200)
            html = await resp.text()
        self.assertIn(f"{public_base}/v/test_clip", html)

        async with self.client.get(f"{public_base}/v/test_clip") as resp:
            self.assertEqual(resp.status, 200)
            self.assertEqual(resp.headers.get("Content-Type"), "video/mp4")

        async with self.client.get(f"{public_base}/t/test_clip") as resp:
            self.assertEqual(resp.status, 200)
            self.assertEqual(resp.headers.get("Content-Type"), "image/jpeg")

    async def test_mkv_clips_are_listed_and_served(self) -> None:
        mkv = self.output_dir / "mkv_clip.mkv"
        mkv.write_bytes(b"not-a-real-mkv")
        self.server.add_clip(mkv)

        local_base = self.server.local_base_url()
        async with self.client.get(f"{local_base}/api/clips") as resp:
            payload = await resp.json()
        slugs = {c["slug"] for c in payload["clips"]}
        self.assertIn("mkv_clip", slugs)

        public_base = f"http://127.0.0.1:{self.public_port}"
        async with self.client.get(f"{public_base}/v/mkv_clip") as resp:
            self.assertEqual(resp.status, 200)

    async def test_embed_page_carries_theme_color_and_player_metadata(self) -> None:
        public_base = self.server.public_base_url()
        async with self.client.get(f"{public_base}/c/test_clip") as resp:
            self.assertEqual(resp.status, 200)
            html = await resp.text()

        self.assertIn('name="theme-color"', html)
        self.assertIn('content="#0099ff"', html)
        self.assertIn("twitter:player:stream", html)
        self.assertIn("og:video:type", html)

    async def test_embed_color_rejects_non_hex_values(self) -> None:
        self.server.cfg.sharing.embed_color = "<script>alert(1)</script>"
        public_base = self.server.public_base_url()
        async with self.client.get(f"{public_base}/c/test_clip") as resp:
            html = await resp.text()

        self.assertNotIn("<script>alert(1)</script>", html)
        self.assertIn('content="#0099ff"', html)

    async def test_public_server_blocks_privileged_routes_and_mutation(self) -> None:
        public_base = f"http://127.0.0.1:{self.public_port}"

        async with self.client.get(f"{public_base}/") as resp:
            self.assertEqual(resp.status, 404)

        async with self.client.get(f"{public_base}/api/clips") as resp:
            self.assertEqual(resp.status, 404)

        async with self.client.post(f"{public_base}/api/trigger") as resp:
            self.assertEqual(resp.status, 404)

        async with self.client.get(f"{public_base}/ws") as resp:
            self.assertEqual(resp.status, 404)

        async with self.client.delete(f"{public_base}/api/clips/test_clip") as resp:
            self.assertEqual(resp.status, 404)

        self.assertTrue(self.clip_path.exists())


@unittest.skipUnless(ShareServer is not None, "aiohttp is not installed")
class ShareServerBaseUrlTests(unittest.TestCase):
    def test_configured_public_base_url_beats_tunnel_and_bind_url(self) -> None:
        cfg = Config(
            sharing=SharingConfig(
                base_url="https://clips.example.com/",
                port=8765,
                public_port=8766,
                cloudflare_tunnel=False,
            )
        )
        server = ShareServer(cfg)
        server._tunnel_url = "https://ignored.trycloudflare.com"
        server._public_bind_url = "http://127.0.0.1:8766"

        self.assertEqual(server.public_base_url(), "https://clips.example.com")


@unittest.skipUnless(ShareServer is not None, "aiohttp is not installed")
class ShareServerUiVersionTests(unittest.IsolatedAsyncioTestCase):
    async def test_ui_response_injects_current_version(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            ui_path = Path(tmp) / "index.html"
            ui_path.write_text(
                '<link href="/styles/base.css?v=__VICE_VERSION__">'
                '<script src="/scripts/settings.js?v=__VICE_VERSION__"></script>'
                "<div>Version __VICE_VERSION__</div>",
                encoding="utf-8",
            )
            server = ShareServer(Config())

            with mock.patch("vice.share._resolve_ui_index", return_value=ui_path):
                response = await server._ui(mock.Mock())

        self.assertEqual(response.status, 200)
        self.assertIn(__version__, response.text)
        self.assertIn(f"/scripts/settings.js?v={__version__}", response.text)
        self.assertNotIn("__VICE_VERSION__", response.text)


@unittest.skipUnless(ShareServer is not None and ClientSession is not None, "aiohttp is not installed")
class ShareServerLegacyUrlCompatibilityTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmpdir.cleanup)

        root = Path(self.tmpdir.name)
        self.output_dir = root / "clips"
        self.output_dir.mkdir()
        self.thumb_dir = root / "thumbs"
        self.thumb_dir.mkdir()
        self.highlights_dir = root / "highlights"
        self.highlights_dir.mkdir()

        self.clip_path = self.output_dir / "legacy_clip.mp4"
        self.clip_path.write_bytes(b"not-a-real-mp4")

        self.thumb_path = self.thumb_dir / "legacy_clip.jpg"
        self.thumb_path.write_bytes(b"jpeg")

        self.local_port = _free_port()
        self.public_port = _free_port()
        while self.public_port == self.local_port:
            self.public_port = _free_port()

        async def _stub_make_thumb(_: Path, duration: float = 0.0) -> Path:
            return self.thumb_path

        self.patchers = [
            mock.patch("vice.share._local_ip", return_value="127.0.0.2"),
            mock.patch("vice.share.THUMB_DIR", self.thumb_dir),
            mock.patch("vice.share.HIGHLIGHTS_DIR", self.highlights_dir),
            mock.patch("vice.share._ffprobe", new=_stub_ffprobe),
            mock.patch("vice.share._make_thumb", new=_stub_make_thumb),
        ]
        for patcher in self.patchers:
            patcher.start()
            self.addCleanup(patcher.stop)

        cfg = Config(
            output=OutputConfig(directory=str(self.output_dir)),
            sharing=SharingConfig(
                port=self.local_port,
                public_port=self.public_port,
                cloudflare_tunnel=False,
            ),
        )
        self.server = ShareServer(cfg)

        await self.server.start()
        self.server.add_clip(self.clip_path)
        self.client = ClientSession()

    async def asyncTearDown(self) -> None:
        await self.client.close()
        await self.server.stop()

    async def test_legacy_pre_v1_0_12_share_urls_still_resolve(self) -> None:
        legacy_base = f"http://127.0.0.2:{self.local_port}"

        async with self.client.get(f"{legacy_base}/c/legacy_clip") as resp:
            self.assertEqual(resp.status, 200)
            html = await resp.text()
        self.assertIn(f"{legacy_base}/v/legacy_clip", html)

        async with self.client.get(f"{legacy_base}/v/legacy_clip") as resp:
            self.assertEqual(resp.status, 200)
            self.assertEqual(resp.headers.get("Content-Type"), "video/mp4")

        async with self.client.get(f"{legacy_base}/t/legacy_clip") as resp:
            self.assertEqual(resp.status, 200)
            self.assertEqual(resp.headers.get("Content-Type"), "image/jpeg")

    async def test_legacy_origin_still_blocks_ui_and_api_routes(self) -> None:
        legacy_base = f"http://127.0.0.2:{self.local_port}"

        async with self.client.get(f"{legacy_base}/") as resp:
            self.assertEqual(resp.status, 404)

        async with self.client.get(f"{legacy_base}/api/clips") as resp:
            self.assertEqual(resp.status, 404)


@unittest.skipUnless(ShareServer is not None, "aiohttp is not installed")
class ShareServerDisplayApiTests(unittest.IsolatedAsyncioTestCase):
    async def test_api_get_displays_returns_backend_options_and_selected_value(self) -> None:
        server = ShareServer(Config(recording=RecordingConfig(display="DP-1", backend="auto")))
        request = mock.Mock(query={"backend": "gsr"})

        with mock.patch(
            "vice.share.list_display_options",
            return_value={
                "backend": "gsr",
                "displays": [{"id": "DP-1", "label": "DP-1"}],
                "warning": None,
            },
        ):
            response = await server._api_get_displays(request)

        payload = json.loads(response.text)
        self.assertEqual(payload["backend"], "gsr")
        self.assertEqual(payload["selected"], "DP-1")
        self.assertEqual(payload["displays"][0]["id"], "DP-1")

    async def test_api_get_audio_sources_returns_gsr_sources_and_selected_value(self) -> None:
        server = ShareServer(Config(recording=RecordingConfig(gsr_audio_source="app:Firefox")))
        request = mock.Mock()

        with mock.patch(
            "vice.share.list_gsr_audio_sources",
            return_value={
                "sources": [{"id": "app:Firefox", "label": "Application: Firefox"}],
                "warning": None,
            },
        ):
            response = await server._api_get_audio_sources(request)

        payload = json.loads(response.text)
        self.assertEqual(payload["selected"], "app:Firefox")
        self.assertEqual(payload["sources"][0]["id"], "app:Firefox")


@unittest.skipUnless(ShareServer is not None, "aiohttp is not installed")
class ShareServerConfigApiTests(unittest.IsolatedAsyncioTestCase):
    async def test_api_set_config_saves_clip_presets_and_grows_buffer(self) -> None:
        server = ShareServer(
            Config(
                recording=RecordingConfig(buffer_duration=60, clip_duration=15),
                hotkeys=HotkeyConfig(clip="KEY_F9"),
            )
        )
        request = _JsonRequest({
            "hotkeys": {
                "clip_presets": [{"key": "KEY_F6", "duration": 120}],
            },
        })

        with mock.patch("vice.config.load", return_value=server.cfg):
            with mock.patch("vice.config.save") as save_mock:
                response = await server._api_set_config(request)

        payload = json.loads(response.text)
        saved_cfg = save_mock.call_args.args[0]
        self.assertTrue(payload["ok"])
        self.assertEqual(saved_cfg.hotkeys.clip_presets[0].key, "KEY_F6")
        self.assertEqual(saved_cfg.hotkeys.clip_presets[0].duration, 120)
        self.assertEqual(saved_cfg.recording.buffer_duration, 120)

    async def test_api_set_config_rejects_duplicate_clip_hotkeys(self) -> None:
        server = ShareServer(Config(hotkeys=HotkeyConfig(clip="KEY_F9")))
        request = _JsonRequest({
            "hotkeys": {
                "clip": "KEY_F9",
                "clip_presets": [{"key": "KEY_F9", "duration": 60}],
            },
        })

        with mock.patch("vice.config.load", return_value=server.cfg):
            with mock.patch("vice.config.save") as save_mock:
                response = await server._api_set_config(request)

        payload = json.loads(response.text)
        self.assertEqual(response.status, 400)
        self.assertFalse(payload["ok"])
        self.assertIn("duplicate clip hotkey", payload["error"])
        save_mock.assert_not_called()


@unittest.skipUnless(ShareServer is not None, "aiohttp is not installed")
class ShareServerClipBroadcastTests(unittest.IsolatedAsyncioTestCase):
    async def test_add_clip_broadcasts_immediately_before_metadata_finishes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            clip_path = Path(tmp) / "clip.mp4"
            clip_path.write_bytes(b"clip")
            server = ShareServer(Config())
            messages: list[dict] = []

            async def _fake_broadcast(msg: dict) -> None:
                messages.append(msg)

            async def _slow_meta(_slug: str, _path: Path) -> dict:
                await asyncio.sleep(0.05)
                return {"width": 1920, "height": 1080, "duration": 6.5}

            async def _fake_thumb(_path: Path, duration: float = 0.0) -> Path:
                return Path(tmp) / "thumb.jpg"

            with mock.patch.object(server, "broadcast", side_effect=_fake_broadcast):
                with mock.patch.object(server, "_get_meta", side_effect=_slow_meta):
                    with mock.patch("vice.share._make_thumb", new=_fake_thumb):
                        server.add_clip(clip_path)
                        await asyncio.sleep(0)
                        self.assertTrue(messages)
                        self.assertEqual(messages[0]["type"], "clip_saved")
                        self.assertEqual(messages[0]["clip"]["duration"], 0)

                        await asyncio.sleep(0.06)

            self.assertEqual(messages[-1]["type"], "clip_saved")
            self.assertEqual(messages[-1]["clip"]["duration"], 6.5)


@unittest.skipUnless(ShareServer is not None, "aiohttp is not installed")
class ShareServerTunnelTests(unittest.IsolatedAsyncioTestCase):
    """The serveo SSH fallback is gone: cloudflared or a clear error."""

    def _server(self) -> "ShareServer":
        return ShareServer(Config(sharing=SharingConfig(cloudflare_tunnel=True)))

    async def test_missing_cloudflared_broadcasts_tunnel_error(self) -> None:
        server = self._server()
        server.broadcast = mock.AsyncMock()

        with mock.patch("vice.share.shutil.which", return_value=None):
            with mock.patch(
                "vice.share.asyncio.create_subprocess_exec",
                new=mock.AsyncMock(),
            ) as exec_mock:
                await server._start_tunnel(8766)

        exec_mock.assert_not_awaited()
        msg = server.broadcast.await_args.args[0]
        self.assertEqual(msg["type"], "tunnel_error")
        self.assertIn("cloudflared", msg["error"])

    async def test_no_serveo_fallback_remains(self) -> None:
        self.assertFalse(hasattr(ShareServer, "_read_serveo_url"))

        # Even with ssh available, nothing must be spawned when
        # cloudflared is missing.
        server = self._server()
        server.broadcast = mock.AsyncMock()
        with mock.patch(
            "vice.share.shutil.which",
            side_effect=lambda name: "/usr/bin/ssh" if name == "ssh" else None,
        ):
            with mock.patch(
                "vice.share.asyncio.create_subprocess_exec",
                new=mock.AsyncMock(),
            ) as exec_mock:
                await server._start_tunnel(8766)

        exec_mock.assert_not_awaited()

    async def test_cloudflared_exit_without_url_reports_error(self) -> None:
        server = self._server()
        server.broadcast = mock.AsyncMock()

        class _Stdout:
            def __aiter__(self):
                return self

            async def __anext__(self):
                raise StopAsyncIteration

        proc = mock.Mock()
        proc.stdout = _Stdout()
        proc.returncode = 1
        server._tunnel_proc = proc

        await server._read_cloudflare_url()

        msg = server.broadcast.await_args.args[0]
        self.assertEqual(msg["type"], "tunnel_error")
        self.assertIn("exited", msg["error"])
