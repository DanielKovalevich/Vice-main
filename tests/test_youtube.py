import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import vice.config as config_module
from vice.config import (
    Config,
    YouTubeConfig,
    YouTubeConnector,
    load,
    normalize_youtube_connectors,
    save,
)
from vice.youtube import (
    YouTubeUploadSpec,
    YouTubeUploadBusy,
    YouTubeUploadManager,
    build_upload_command,
    build_upload_spec,
    connector_preflight,
    parse_video_id,
)


VIDEO_ID = "abc_DEF-123"


class _FakeStream:
    def __init__(self, data: bytes) -> None:
        self._chunks = [data] if data else []

    async def read(self, _: int) -> bytes:
        await asyncio.sleep(0)
        if self._chunks:
            return self._chunks.pop(0)
        return b""


class _FakeProcess:
    def __init__(
        self,
        *,
        stdout: bytes = b"",
        stderr: bytes = b"",
        exit_code: int = 0,
        block: bool = False,
    ) -> None:
        self.stdout = _FakeStream(stdout)
        self.stderr = _FakeStream(stderr)
        self.returncode = None
        self._exit_code = exit_code
        self._block = block
        self._finished = asyncio.Event()
        self.terminated = False
        self.killed = False

    async def wait(self) -> int:
        if self._block:
            await self._finished.wait()
        if self.returncode is None:
            self.returncode = self._exit_code
        return self.returncode

    def terminate(self) -> None:
        self.terminated = True
        self.returncode = -15
        self._finished.set()

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9
        self._finished.set()


def _connector(**overrides) -> YouTubeConnector:
    values = {
        "id": "cs2",
        "name": "CS2",
        "description": "CS2 Clip",
        "privacy": "unlisted",
        "tags": ["CS2", "clutch"],
        "playlist_ids": ["PL-one", "PL-two"],
        "notify": False,
    }
    values.update(overrides)
    return YouTubeConnector(**values)


def _metadata(**overrides) -> YouTubeUploadSpec:
    values = {
        "title": "ace",
        "description": "CS2 Clip",
        "privacy": "unlisted",
        "tags": ["CS2"],
        "playlist_ids": ["PL-one"],
        "notify": False,
    }
    values.update(overrides)
    return YouTubeUploadSpec(**values)


class YouTubeConnectorTests(unittest.TestCase):
    def test_lenient_normalization_handles_hand_edited_values(self) -> None:
        connectors = normalize_youtube_connectors([
            {
                "id": "cs2",
                "name": " CS2 ",
                "tags": None,
                "playlist_ids": "PL-one\nPL-two",
                "notify": "false",
            },
            None,
            "not-a-table",
        ])

        self.assertEqual(len(connectors), 1)
        self.assertEqual(connectors[0].name, "CS2")
        self.assertEqual(connectors[0].tags, [])
        self.assertEqual(connectors[0].playlist_ids, ["PL-one", "PL-two"])
        self.assertFalse(connectors[0].notify)

    def test_strict_validation_rejects_invalid_and_duplicate_connectors(self) -> None:
        with self.assertRaisesRegex(ValueError, "needs a name"):
            normalize_youtube_connectors(
                [{"id": "cs2", "name": ""}],
                strict=True,
            )

        with self.assertRaisesRegex(ValueError, "duplicate"):
            normalize_youtube_connectors(
                [
                    {"id": "same", "name": "CS2"},
                    {"id": "same", "name": "Deadlock"},
                ],
                strict=True,
            )

        with self.assertRaisesRegex(ValueError, "notifications value"):
            normalize_youtube_connectors(
                [{
                    "id": "cs2",
                    "name": "CS2",
                    "notify": 1,
                }],
                strict=True,
            )

    def test_config_round_trip_preserves_connectors_and_omits_none_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config_path = root / "config.toml"
            cfg = Config(youtube=YouTubeConfig(
                executable="/opt/youtubeuploader",
                connectors=[_connector()],
            ))

            with mock.patch.multiple(
                config_module,
                CONFIG_DIR=root,
                CONFIG_PATH=config_path,
            ):
                save(cfg)
                loaded = load()

            text = config_path.read_text()
            self.assertNotIn("secrets_path", text)
            self.assertNotIn("cache_path", text)
            self.assertEqual(loaded.youtube.executable, "/opt/youtubeuploader")
            self.assertEqual(loaded.youtube.connectors, [_connector()])

    def test_title_rendering_and_overrides_match_clip_metadata(self) -> None:
        connector = _connector(title_template="$filename - $game")
        clip = Path("/clips/my-ace.mp4")

        spec = build_upload_spec(
            connector,
            clip,
            overrides={
                "title": "Final title",
                "description": "One-off description",
                "privacy": "private",
                "tags": ["ace", "ranked"],
                "playlist_ids": ["PL-final"],
            },
            game="CS2",
        )
        self.assertEqual(spec.title, "Final title")
        self.assertEqual(spec.description, "One-off description")
        self.assertEqual(spec.privacy, "private")
        self.assertEqual(spec.tags, ["ace", "ranked"])
        self.assertEqual(spec.playlist_ids, ["PL-final"])
        templated = build_upload_spec(connector, clip, game="CS2")
        self.assertEqual(templated.title, "my-ace - CS2")

    def test_upload_spec_rejects_invalid_overrides(self) -> None:
        with self.assertRaisesRegex(ValueError, "privacy"):
            build_upload_spec(
                _connector(),
                Path("/clips/ace.mp4"),
                overrides={"privacy": "friends-only"},
            )

        with self.assertRaisesRegex(ValueError, "title"):
            build_upload_spec(
                _connector(),
                Path("/clips/ace.mp4"),
                overrides={"title": "  "},
            )

    def test_command_uses_exact_cli_flag_shapes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            clip = root / "ace.mp4"
            secrets = root / "client_secrets.json"
            cache = root / "request.token"
            connector = _connector(
                secrets_path=str(secrets),
                cache_path=str(cache),
            )
            spec = _metadata(
                tags=["CS2", "clutch"],
                playlist_ids=["PL-one", "PL-two"],
            )

            self.assertEqual(build_upload_command(
                "/usr/bin/youtubeuploader",
                connector,
                clip,
                spec,
            ), [
                "/usr/bin/youtubeuploader",
                "-quiet",
                "-filename", str(clip),
                "-title", "ace",
                "-description", "CS2 Clip",
                "-privacy", "unlisted",
                "-oAuthPort", "8080",
                "-tags", "CS2,clutch",
                "-playlistID", "PL-one",
                "-playlistID", "PL-two",
                "-secrets", str(secrets),
                "-cache", str(cache),
                "-notify=false",
            ])

    def test_video_id_parser_accepts_dash_and_underscore_from_stdout_only(self) -> None:
        self.assertEqual(parse_video_id(f"Video ID: {VIDEO_ID}\n"), VIDEO_ID)
        self.assertIsNone(parse_video_id("Video ID: too-short"))
        self.assertIsNone(parse_video_id(f"error: {VIDEO_ID}"))

    def test_preflight_requires_explicit_auth_files_when_configured(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            secrets = root / "client_secrets.json"
            secrets.write_text("{}")
            missing_cache = root / "request.token"
            connector = _connector(
                secrets_path=str(secrets),
                cache_path=str(missing_cache),
            )

            with mock.patch(
                "vice.youtube.resolve_uploader_executable",
                return_value="/usr/bin/youtubeuploader",
            ):
                status = connector_preflight("youtubeuploader", connector)

        self.assertFalse(status["available"])
        self.assertIn("Authenticate this connector once", status["error"])
        self.assertIn("from a terminal", status["error"])

    def test_preflight_reports_missing_executable(self) -> None:
        with mock.patch(
            "vice.youtube.resolve_uploader_executable",
            return_value=None,
        ):
            status = connector_preflight("youtubeuploader", _connector())

        self.assertFalse(status["available"])
        self.assertIn("was not found", status["error"])


class YouTubeUploadManagerTests(unittest.IsolatedAsyncioTestCase):
    async def _run_process(self, proc: _FakeProcess) -> tuple[YouTubeUploadManager, mock.AsyncMock]:
        broadcast = mock.AsyncMock()
        manager = YouTubeUploadManager(broadcast)
        with mock.patch(
            "vice.youtube.asyncio.create_subprocess_exec",
            new=mock.AsyncMock(return_value=proc),
        ):
            manager.start(
                slug="ace",
                connector=_connector(),
                command=["/usr/bin/youtubeuploader"],
                spec=_metadata(),
            )
            task = manager._task
            self.assertIsNotNone(task)
            await task
        return manager, broadcast

    async def test_success_emits_video_url(self) -> None:
        manager, broadcast = await self._run_process(_FakeProcess(
            stdout=f"Video ID: {VIDEO_ID}\n".encode(),
        ))

        status = manager.status()
        self.assertIsNotNone(status)
        self.assertEqual(status["status"], "done")
        self.assertEqual(status["url"], f"https://youtu.be/{VIDEO_ID}")
        self.assertEqual(broadcast.await_args_list[-1].args[0]["type"], "youtube_upload_done")
        self.assertFalse(broadcast.await_args_list[-1].args[0]["partial"])

    async def test_nonzero_exit_with_video_id_is_partial_success(self) -> None:
        manager, broadcast = await self._run_process(_FakeProcess(
            stdout=f"Video ID: {VIDEO_ID}\n".encode(),
            stderr=b"Error adding video to playlist\n",
            exit_code=1,
        ))

        status = manager.status()
        self.assertIsNotNone(status)
        self.assertEqual(status["status"], "partial")
        self.assertEqual(status["url"], f"https://youtu.be/{VIDEO_ID}")
        self.assertIn("playlist", status["warning"])
        event = broadcast.await_args_list[-1].args[0]
        self.assertEqual(event["type"], "youtube_upload_done")
        self.assertTrue(event["partial"])

    async def test_missing_video_id_is_an_error(self) -> None:
        manager, broadcast = await self._run_process(_FakeProcess(
            stderr=b"quota exceeded\n",
            exit_code=1,
        ))

        status = manager.status()
        self.assertIsNotNone(status)
        self.assertEqual(status["status"], "error")
        self.assertIn("quota exceeded", status["error"])
        self.assertEqual(broadcast.await_args_list[-1].args[0]["type"], "youtube_upload_error")

    async def test_zero_exit_without_video_id_is_still_an_error(self) -> None:
        manager, _ = await self._run_process(_FakeProcess(
            stdout=b"upload finished\n",
            exit_code=0,
        ))

        status = manager.status()
        self.assertIsNotNone(status)
        self.assertEqual(status["status"], "error")
        self.assertNotIn("url", status)

    async def test_missing_executable_is_reported(self) -> None:
        manager = YouTubeUploadManager(mock.AsyncMock())
        with mock.patch(
            "vice.youtube.asyncio.create_subprocess_exec",
            new=mock.AsyncMock(side_effect=FileNotFoundError("not found")),
        ):
            manager.start(
                slug="ace",
                connector=_connector(),
                command=["missing-youtubeuploader"],
                spec=_metadata(),
            )
            task = manager._task
            self.assertIsNotNone(task)
            await task

        status = manager.status()
        self.assertIsNotNone(status)
        self.assertEqual(status["status"], "error")
        self.assertIn("not found", status["error"])

    async def test_video_id_on_stderr_is_not_treated_as_success(self) -> None:
        manager, _ = await self._run_process(_FakeProcess(
            stderr=f"Video ID: {VIDEO_ID}\n".encode(),
            exit_code=1,
        ))

        status = manager.status()
        self.assertIsNotNone(status)
        self.assertEqual(status["status"], "error")
        self.assertNotIn("url", status)

    async def test_only_one_upload_can_run(self) -> None:
        proc = _FakeProcess(block=True)
        manager = YouTubeUploadManager(mock.AsyncMock())
        with mock.patch(
            "vice.youtube.asyncio.create_subprocess_exec",
            new=mock.AsyncMock(return_value=proc),
        ):
            job = manager.start(
                slug="ace",
                connector=_connector(),
                command=["/usr/bin/youtubeuploader"],
                spec=_metadata(),
            )
            await asyncio.sleep(0)
            with self.assertRaises(YouTubeUploadBusy):
                manager.start(
                    slug="second",
                    connector=_connector(),
                    command=["/usr/bin/youtubeuploader"],
                    spec=_metadata(),
                )
            await manager.cancel(job["job_id"])

    async def test_cancel_terminates_process_and_reports_cancellation(self) -> None:
        proc = _FakeProcess(block=True)
        manager = YouTubeUploadManager(mock.AsyncMock())
        with mock.patch(
            "vice.youtube.asyncio.create_subprocess_exec",
            new=mock.AsyncMock(return_value=proc),
        ):
            job = manager.start(
                slug="ace",
                connector=_connector(),
                command=["/usr/bin/youtubeuploader"],
                spec=_metadata(),
            )
            await asyncio.sleep(0)
            self.assertTrue(await manager.cancel(job["job_id"]))

        self.assertTrue(proc.terminated)
        status = manager.status()
        self.assertIsNotNone(status)
        self.assertEqual(status["status"], "canceled")
        self.assertEqual(status["error"], "YouTube upload canceled")

    async def test_cancel_after_video_id_is_partial_success(self) -> None:
        proc = _FakeProcess(
            stdout=f"Video ID: {VIDEO_ID}\n".encode(),
            block=True,
        )
        manager = YouTubeUploadManager(mock.AsyncMock())
        with mock.patch(
            "vice.youtube.asyncio.create_subprocess_exec",
            new=mock.AsyncMock(return_value=proc),
        ):
            job = manager.start(
                slug="ace",
                connector=_connector(),
                command=["/usr/bin/youtubeuploader"],
                spec=_metadata(),
            )
            await asyncio.sleep(0)
            self.assertTrue(await manager.cancel(job["job_id"]))

        status = manager.status()
        self.assertIsNotNone(status)
        self.assertEqual(status["status"], "partial")
        self.assertTrue(status["canceled"])
        self.assertEqual(status["url"], f"https://youtu.be/{VIDEO_ID}")
        self.assertIn("already exists", status["warning"])

    async def test_shutdown_cleans_up_active_process(self) -> None:
        proc = _FakeProcess(block=True)
        manager = YouTubeUploadManager(mock.AsyncMock())
        with mock.patch(
            "vice.youtube.asyncio.create_subprocess_exec",
            new=mock.AsyncMock(return_value=proc),
        ):
            manager.start(
                slug="ace",
                connector=_connector(),
                command=["/usr/bin/youtubeuploader"],
                spec=_metadata(),
            )
            await asyncio.sleep(0)
            await manager.shutdown()

        self.assertTrue(proc.terminated)
        task = manager._task
        self.assertIsNotNone(task)
        self.assertTrue(task.done())

    async def test_diagnostic_output_is_bounded(self) -> None:
        manager, _ = await self._run_process(_FakeProcess(
            stderr=b"x" * 100_000,
            exit_code=1,
        ))

        status = manager.status()
        self.assertIsNotNone(status)
        self.assertLessEqual(len(status["error"]), 2_000)


if __name__ == "__main__":
    unittest.main()
