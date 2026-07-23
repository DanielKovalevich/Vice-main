import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest import mock

from click.testing import CliRunner

try:
    from vice import main as main_mod
except ModuleNotFoundError:
    import sys
    import types

    stub_share = types.ModuleType("vice.share")
    stub_share.ShareServer = object
    sys.modules["vice.share"] = stub_share
    from vice import main as main_mod

from vice import __version__
from vice.main import cli


class _FakeStartDaemon:
    def __init__(self) -> None:
        self.cfg = mock.Mock()
        self.cfg.sharing.enabled = True
        self.cfg.sharing.port = 8765
        self.run_called = False

    async def run(self) -> None:
        self.run_called = True


class CliVersionTests(unittest.TestCase):
    def test_version_flag_reports_current_release(self) -> None:
        runner = CliRunner()
        result = runner.invoke(cli, ["--version"])

        self.assertEqual(result.exit_code, 0)
        self.assertIn(f"vice, version {__version__}", result.output)

    def test_python_and_packaging_versions_stay_in_sync(self) -> None:
        repo_root = Path(__file__).resolve().parents[1]
        pyproject = tomllib.loads((repo_root / "pyproject.toml").read_text())
        pkgbuild = (repo_root / "PKGBUILD").read_text()
        srcinfo = (repo_root / ".SRCINFO").read_text()

        # pyproject reads its version dynamically from vice.__version__, so
        # the Python module is the single source of truth for the wheel.
        self.assertIn("version", pyproject["project"].get("dynamic", []))
        self.assertEqual(
            pyproject["tool"]["setuptools"]["dynamic"]["version"]["attr"],
            "vice.__version__",
        )
        # PKGBUILD/.SRCINFO are a separate ecosystem; this catches drift.
        self.assertIn(f"pkgver={__version__}", pkgbuild)
        self.assertIn(f"pkgver = {__version__}", srcinfo)


class StartCommandTests(unittest.TestCase):
    def test_start_help_documents_no_open_ui_flag(self) -> None:
        runner = CliRunner()
        result = runner.invoke(cli, ["start", "--help"])

        self.assertEqual(result.exit_code, 0)
        self.assertIn("--open-ui / --no-open-ui", result.output)
        self.assertIn("Open the web UI in the browser on start.", result.output)

    def test_start_no_open_ui_does_not_spawn_browser(self) -> None:
        runner = CliRunner()
        daemon = _FakeStartDaemon()

        with mock.patch("vice.main.normalize_runtime_environment"), \
             mock.patch("vice.main._setup_daemon_logging"), \
             mock.patch("vice.main.runtime_env_snapshot", return_value={}), \
             mock.patch("vice.main.SOCKET_FILE", Path("/tmp/vice-test-missing.sock")), \
             mock.patch("vice.main.ViceDaemon", return_value=daemon), \
             mock.patch("vice.main.subprocess.Popen") as popen_mock:
            result = runner.invoke(cli, ["start", "--no-open-ui"])

        self.assertEqual(result.exit_code, 0)
        self.assertTrue(daemon.run_called)
        popen_mock.assert_not_called()


class DoctorCommandTests(unittest.TestCase):
    def test_doctor_reports_key_diagnostics(self) -> None:
        runner = CliRunner()
        fake_cfg = mock.Mock()
        fake_cfg.sharing.port = 8765
        fake_recorder = mock.Mock(name="wf-recorder")
        fake_recorder.name = "wf-recorder"

        with mock.patch("vice.main.load_config", return_value=fake_cfg):
            with mock.patch("vice.main.create_recorder", return_value=fake_recorder):
                with mock.patch("vice.main.runtime_env_snapshot", return_value={"WAYLAND_DISPLAY": "wayland-0"}):
                    with mock.patch(
                        "vice.main.user_systemd_env_snapshot",
                        return_value={"WAYLAND_DISPLAY": "wayland-0", "XDG_RUNTIME_DIR": "/run/user/1000"},
                    ):
                        with mock.patch("vice.main._ipc", return_value=None):
                            with mock.patch("vice.main._http_probe", return_value=(False, "connection refused")):
                                with mock.patch("vice.main._tail_text_file", return_value="line one\nline two"):
                                    with mock.patch("vice.main.shutil.which", side_effect=lambda cmd: f"/usr/bin/{cmd}"):
                                        result = runner.invoke(cli, ["doctor"])

        self.assertEqual(result.exit_code, 0)
        self.assertIn("Vice doctor", result.output)
        self.assertIn(f"Version         : {__version__}", result.output)
        self.assertIn("Environment", result.output)
        self.assertIn("User systemd environment", result.output)
        self.assertIn("Recorder probe", result.output)
        self.assertIn("OK: Mock (wf-recorder)", result.output)
        self.assertIn("HTTP: error (connection refused) http://localhost:8765/", result.output)
        self.assertIn("Recent daemon log", result.output)
        self.assertIn("line two", result.output)


class UninstallCommandTests(unittest.TestCase):
    def test_aur_detection_checks_package_ownership_of_vice_binary(self) -> None:
        with mock.patch("vice.main.shutil.which", side_effect=["/usr/bin/pacman", "/usr/bin/vice"]):
            with mock.patch("vice.main.subprocess.run") as run_mock:
                run_mock.side_effect = [
                    mock.Mock(returncode=0, stdout="vice-clipper 1.0.17-1\n"),
                    mock.Mock(returncode=0, stdout="/usr/bin/vice is owned by vice-clipper 1.0.17-1\n"),
                ]
                detected = main_mod._installed_via_aur()

        self.assertTrue(detected)
        self.assertEqual(run_mock.call_count, 2)

    def test_aur_install_returns_early_with_instruction(self) -> None:
        runner = CliRunner()
        with mock.patch("vice.main._installed_via_aur", return_value=True):
            with mock.patch("vice.main._ipc") as ipc_mock:
                with mock.patch("vice.main.subprocess.run") as run_mock:
                    result = runner.invoke(cli, ["uninstall", "--yes"])

        self.assertEqual(result.exit_code, 0)
        self.assertIn("Vice was installed via AUR.", result.output)
        self.assertIn("yay -Rns vice-clipper", result.output)
        ipc_mock.assert_not_called()
        run_mock.assert_not_called()

    def test_local_uninstall_removes_only_vice_managed_youtubeuploader(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            user_bin = root / "bin"
            user_bin.mkdir()
            uploader = user_bin / "youtubeuploader"
            uploader.write_text("managed")
            marker = root / "share" / "vice" / "youtubeuploader.version"
            marker.parent.mkdir(parents=True)
            marker.write_text("1.25.5")
            license_dir = root / "share" / "vice" / "licenses" / "youtubeuploader"
            license_dir.mkdir(parents=True)
            (license_dir / "LICENSE").write_text("Apache-2.0")

            with mock.patch.multiple(
                main_mod,
                USER_BIN_DIR=user_bin,
                USER_DESKTOP_FILE=root / "missing.desktop",
                USER_ICON_FILE=root / "missing.svg",
                YOUTUBE_UPLOADER_MARKER=marker,
                YOUTUBE_UPLOADER_LICENSE_DIR=license_dir,
            ):
                removed = main_mod._remove_local_install_artifacts()

            self.assertFalse(uploader.exists())
            self.assertFalse(marker.exists())
            self.assertFalse(license_dir.exists())
            self.assertIn(uploader, removed)
            self.assertIn(marker, removed)
            self.assertIn(license_dir, removed)

    def test_local_uninstall_preserves_unmanaged_youtubeuploader(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            user_bin = root / "bin"
            user_bin.mkdir()
            uploader = user_bin / "youtubeuploader"
            uploader.write_text("user-managed")

            with mock.patch.multiple(
                main_mod,
                USER_BIN_DIR=user_bin,
                USER_DESKTOP_FILE=root / "missing.desktop",
                USER_ICON_FILE=root / "missing.svg",
                YOUTUBE_UPLOADER_MARKER=root / "missing.version",
                YOUTUBE_UPLOADER_LICENSE_DIR=root / "missing-license",
            ):
                removed = main_mod._remove_local_install_artifacts()

            self.assertTrue(uploader.exists())
            self.assertNotIn(uploader, removed)

    def test_local_uninstall_ignores_empty_uploader_marker(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            user_bin = root / "bin"
            user_bin.mkdir()
            uploader = user_bin / "youtubeuploader"
            uploader.write_text("user-managed")
            marker = root / "youtubeuploader.version"
            marker.write_text("")

            with mock.patch.multiple(
                main_mod,
                USER_BIN_DIR=user_bin,
                USER_DESKTOP_FILE=root / "missing.desktop",
                USER_ICON_FILE=root / "missing.svg",
                YOUTUBE_UPLOADER_MARKER=marker,
                YOUTUBE_UPLOADER_LICENSE_DIR=root / "missing-license",
            ):
                removed = main_mod._remove_local_install_artifacts()

            self.assertTrue(uploader.exists())
            self.assertTrue(marker.exists())
            self.assertNotIn(uploader, removed)

    def test_user_site_uninstall_uses_pip_and_skips_desktop_cache_refresh_without_files(self) -> None:
        runner = CliRunner()
        with mock.patch("vice.main._installed_via_aur", return_value=False), \
             mock.patch("vice.main.SOCKET_FILE", Path("/tmp/does-not-exist.sock")), \
             mock.patch("vice.main.actual_home_dir", return_value=Path("/tmp/vice-test-home")), \
             mock.patch("vice.main.CONFIG_DIR", Path("/tmp/does-not-exist-config")), \
             mock.patch("vice.main.CONFIG_PATH", Path("/tmp/does-not-exist-config.toml")), \
             mock.patch("vice.main.load_config") as load_config_mock, \
             mock.patch("vice.main._using_install_script_venv", return_value=False), \
             mock.patch("vice.main._remove_local_install_artifacts", return_value=[]), \
             mock.patch("vice.main._refresh_desktop_caches") as refresh_mock, \
             mock.patch("vice.main.subprocess.run") as run_mock:
            result = runner.invoke(cli, ["uninstall", "--yes"])

        self.assertEqual(result.exit_code, 0)
        self.assertIn("Uninstalling Python package", result.output)
        load_config_mock.assert_not_called()
        run_mock.assert_called_once()
        self.assertEqual(run_mock.call_args.args[0][1:], ["-m", "pip", "uninstall", "vice", "-y"])
        refresh_mock.assert_not_called()

    def test_install_script_venv_uninstall_removes_venv_without_pip(self) -> None:
        runner = CliRunner()
        with mock.patch("vice.main._installed_via_aur", return_value=False), \
             mock.patch("vice.main.SOCKET_FILE", Path("/tmp/does-not-exist.sock")), \
             mock.patch("vice.main.actual_home_dir", return_value=Path("/tmp/vice-test-home")), \
             mock.patch("vice.main.CONFIG_DIR", Path("/tmp/does-not-exist-config")), \
             mock.patch("vice.main.CONFIG_PATH", Path("/tmp/does-not-exist-config.toml")), \
             mock.patch("vice.main.load_config") as load_config_mock, \
             mock.patch("vice.main._using_install_script_venv", return_value=True), \
             mock.patch("vice.main.shutil.rmtree") as rmtree_mock, \
             mock.patch(
                 "vice.main._remove_local_install_artifacts",
                 return_value=[Path("/home/test/.local/bin/vice")],
             ), \
             mock.patch("vice.main._refresh_desktop_caches") as refresh_mock, \
             mock.patch("vice.main.subprocess.run") as run_mock:
            result = runner.invoke(cli, ["uninstall", "--yes"])

        self.assertEqual(result.exit_code, 0)
        self.assertIn("Removing Vice virtual environment", result.output)
        self.assertIn("Removed local Vice install files", result.output)
        load_config_mock.assert_not_called()
        rmtree_mock.assert_called_once_with(mock.ANY, ignore_errors=True)
        run_mock.assert_not_called()
        refresh_mock.assert_called_once_with()
