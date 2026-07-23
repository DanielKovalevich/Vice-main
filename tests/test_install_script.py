import re
import shlex
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
INSTALL_SH = REPO_ROOT / "install.sh"


class InstallScriptTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.script = INSTALL_SH.read_text(encoding="utf-8")

    def test_gsr_source_build_uses_pinned_refs_and_override(self) -> None:
        script = self.script

        self.assertIn('GSR_DEFAULT_REF="5.13.3"', script)
        self.assertIn('GSR_FFMPEG6_REF="5.12.5"', script)
        self.assertIn('VICE_GSR_REF:-', script)
        self.assertIn("major < 59", script)
        self.assertIn('git clone --depth 1 --branch "$gsr_ref" "$GSR_REPO_URL" "$tmpdir"', script)

    def test_rpm_ostree_guard_runs_before_package_manager_detection(self) -> None:
        script = self.script

        self.assertIn("/run/ostree-booted", script)
        self.assertIn("rpm-ostree", script)
        self.assertIn("Bazzite / Fedora Atomic", script)
        self.assertIn("Silverblue", script)
        self.assertIn("dnf is not the right install path", script)
        self.assertLess(script.index("if is_rpm_ostree_system; then"), script.index("detect_package_manager()"))

    def test_gsr_build_runs_as_user_with_sudo_only_for_install(self) -> None:
        """Regression test for #84: building under sudo left a root-owned
        tree in /tmp that cleanup could not delete."""
        script = self.script

        # The upstream installer (which runs everything as root) is gone.
        self.assertNotIn("sudo ./install.sh", script)
        # Build steps run unprivileged; only meson install is elevated.
        self.assertIn("meson setup build", script)
        self.assertNotIn("sudo meson setup", script)
        self.assertNotIn("sudo ninja", script)
        self.assertIn("sudo meson install -C build", script)
        # Cleanup has a sudo fallback for any root-owned leftovers.
        self.assertIn('rm -rf "$tmpdir" 2>/dev/null || sudo rm -rf "$tmpdir"', script)

    def test_fedora_ffmpeg_devel_matches_installed_ffmpeg(self) -> None:
        """Regression test for #115: RPM Fusion systems have ffmpeg, not
        ffmpeg-free, so the -devel package must match."""
        script = self.script

        self.assertIn("_fedora_ffmpeg_devel()", script)
        self.assertIn("rpm -q ffmpeg &>/dev/null", script)
        self.assertIn("printf 'ffmpeg-devel\\n'", script)
        self.assertIn("printf 'ffmpeg-free-devel\\n'", script)

        match = re.search(
            r"dnf\)\s+local ffmpeg_devel.*?_dnf_install_best_effort (?P<packages>.*?)\n\s+;;",
            script,
            flags=re.S,
        )
        self.assertIsNotNone(match)
        self.assertIn('"$ffmpeg_devel"', match.group("packages"))
        self.assertNotIn("ffmpeg-free-devel", match.group("packages"))

    def test_clipboard_tools_installed_per_session_type(self) -> None:
        script = self.script

        self.assertIn("wl-clipboard", script)
        self.assertIn("xclip", script)
        # Present in every package-manager branch.
        for mgr in ("apt-get install -y wl-clipboard",
                    "dnf install -y wl-clipboard",
                    "zypper install -y wl-clipboard"):
            self.assertIn(mgr, script)

    def test_xwayland_game_detection_tools_installed_by_every_package_manager(self) -> None:
        script = self.script

        self.assertIn("xdotool xorg-xprop wmctrl", script)
        self.assertIn("xdotool x11-utils wmctrl", script)
        self.assertGreaterEqual(script.count("xdotool xprop wmctrl"), 2)

    def test_service_imports_graphical_environment_before_start(self) -> None:
        script = self.script
        import_cmd = (
            "systemctl --user import-environment WAYLAND_DISPLAY DISPLAY "
            "XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS XDG_SESSION_TYPE XDG_CURRENT_DESKTOP"
        )

        self.assertIn(import_cmd, script)
        self.assertLess(
            script.index(import_cmd),
            script.index("systemctl --user enable --now vice.service"),
        )

    def test_apt_gsr_build_deps_include_upstream_required_headers(self) -> None:
        match = re.search(
            r"apt\)\s+sudo apt-get install -y (?P<packages>.*?) \|\| return 1",
            self.script,
            flags=re.S,
        )
        self.assertIsNotNone(match)
        packages = set(re.findall(r"[A-Za-z0-9_.+-]+", match.group("packages")))

        required = {
            "build-essential",
            "linux-libc-dev",
            "libx11-dev",
            "libavfilter-dev",
            "libva-dev",
            "libcap-dev",
            "libdbus-1-dev",
            "libvulkan-dev",
            "libspa-0.2-dev",
            "libpipewire-0.3-dev",
            "libavcodec-dev",
            "libavformat-dev",
            "libavutil-dev",
            "libswresample-dev",
        }
        self.assertTrue(required.issubset(packages), required - packages)

    def test_dnf_gsr_build_deps_match_the_apt_branch(self) -> None:
        """Fedora was missing a C++ compiler, libva, vulkan and libcap, so the
        source build failed one meson check at a time."""
        match = re.search(
            r"dnf\)\s+local ffmpeg_devel.*?_dnf_install_best_effort (?P<packages>.*?)\n\s+;;",
            self.script,
            flags=re.S,
        )
        self.assertIsNotNone(match)
        packages = set(re.findall(r"[A-Za-z0-9_.+-]+", match.group("packages")))

        required = {"gcc-c++", "libva-devel", "vulkan-loader-devel", "libcap-devel"}
        self.assertTrue(required.issubset(packages), required - packages)

    def test_dnf_build_deps_retry_individually(self) -> None:
        # One unavailable name on an unusual arch used to abort the whole
        # transaction before meson could report the real missing dependency.
        self.assertIn("_dnf_install_best_effort()", self.script)
        self.assertIn('sudo dnf install -y "$pkg"', self.script)

    def test_fedora_qtpy_package_uses_capitalised_name(self) -> None:
        # Fedora ships python3-QtPy and dnf5 matches case-sensitively.
        self.assertIn("sudo dnf install -y python3-QtPy", self.script)
        # Installing the Qt stack as one command meant the case mismatch also
        # dropped PyQt6 and QtWebEngine to PyPI wheels.
        self.assertNotIn(
            "python3-pyqt6 python3-pyqt6-webengine python3-qtpy >/dev/null", self.script
        )

    def test_cloudflared_rpm_matches_machine_architecture(self) -> None:
        self.assertIn('cloudflared-linux-${_cf_arch}.rpm', self.script)
        self.assertIn("aarch64|arm64) _cf_arch=arm64", self.script)

    def test_youtubeuploader_install_is_verified_optional_and_arch_aware(self) -> None:
        script = self.script
        start = script.index("install_youtube_uploader()")
        end = script.index("\ninstall_youtube_uploader\n", start)
        section = script[start:end]

        self.assertIn('YOUTUBE_UPLOADER_VERSION="1.25.5"', script)
        self.assertIn('target="$USER_BIN/youtubeuploader"', section)
        self.assertIn("command -v youtubeuploader", section)
        self.assertIn("Keeping user-managed youtubeuploader", section)
        self.assertIn('-e "$target" || -L "$target"', section)
        self.assertIn('-L "$marker"', section)
        self.assertIn("youtubeuploader.version", section)
        self.assertIn('cat "$marker" 2>/dev/null || true', section)
        self.assertIn("sha256sum", section)
        self.assertIn('actual_sha" != "$expected_sha', section)
        self.assertIn("curl -fL --retry 3", section)
        self.assertIn("wget -q --tries=3", section)
        self.assertNotIn("exit 1", section)

        for asset, digest in {
            "Linux_amd64": "b04c964040102d47bc6675531cfb47e7a8d445318064f5b6b6e36b09859743b6",
            "Linux_arm64": "f535957eb56e24a0e73854b798c408b5140a36f9f82423379261c06a5c77e0bd",
            "Linux_armv7": "2855032bf13184c7e5c57c7551208fcec19d0cb185be5243bd9a03cc1ac1eaa9",
            "Linux_armv6": "12277914cb48d456cf2189ed113cbf6d40344309c7f5fd03ad0f407b09dd17c1",
        }.items():
            self.assertIn(f'asset="{asset}"', section)
            self.assertIn(f'expected_sha="{digest}"', section)

        self.assertLess(
            script.index("\ninstall_youtube_uploader\n", start),
            script.index("# ── Install pywebview system deps"),
        )

    def test_youtubeuploader_download_failure_does_not_abort_install(self) -> None:
        bash = shutil.which("bash")
        if bash is None:
            self.skipTest("bash is unavailable")

        start = self.script.index("install_youtube_uploader()")
        end = self.script.index("\ninstall_youtube_uploader\n", start)
        function = self.script[start:end]
        with tempfile.TemporaryDirectory() as tmp:
            home = shlex.quote(Path(tmp).as_posix())
            harness = f"""
set -euo pipefail
HOME={home}
USER_BIN="$HOME/.local/bin"
YOUTUBE_UPLOADER_VERSION="1.25.5"
YOUTUBE_UPLOADER_RELEASE_BASE="https://invalid.example"
info() {{ :; }}
warn() {{ :; }}
command() {{
    if [[ "$#" -ge 2 && "$1" == "-v" && "$2" == "youtubeuploader" ]]; then
        return 1
    fi
    builtin command "$@"
}}
curl() {{ return 22; }}
{function}
install_youtube_uploader
printf 'continued'
"""
            result = subprocess.run(
                [bash, "-c", harness],
                check=False,
                capture_output=True,
                text=True,
            )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "continued")

    def test_no_stale_serveo_references(self) -> None:
        # serveo was removed as a tunnel in v1.3.3, but the installer still
        # promised it as a fallback, which confused the reporter of #105.
        self.assertNotIn("serveo", self.script.lower())


class PackagingTests(unittest.TestCase):
    def test_aur_package_ships_user_service(self) -> None:
        """Regression test for #116: the AUR package installed no systemd
        unit, so the daemon never started at login."""
        service = (REPO_ROOT / "packaging" / "vice.service").read_text()
        self.assertIn("ExecStart=/usr/bin/vice start --no-open-ui", service)
        self.assertIn("WantedBy=graphical-session.target", service)
        self.assertIn("PassEnvironment=WAYLAND_DISPLAY DISPLAY", service)

        pkgbuild = (REPO_ROOT / "PKGBUILD").read_text()
        self.assertIn("packaging/vice.service", pkgbuild)
        self.assertIn("/usr/lib/systemd/user/vice.service", pkgbuild)
        self.assertIn("install=vice-clipper.install", pkgbuild)

    def test_clipboard_and_tunnel_tools_are_hard_dependencies(self) -> None:
        """Copy-to-clipboard and public links silently failed on the AUR
        package because these were only optdepends."""
        import re
        pkgbuild = (REPO_ROOT / "PKGBUILD").read_text()
        depends = re.search(r"depends=\((.*?)\)", pkgbuild, flags=re.S).group(1)
        optdepends = re.search(r"optdepends=\((.*?)\)", pkgbuild, flags=re.S).group(1)
        for pkg in ("wl-clipboard", "xclip", "cloudflared"):
            self.assertIn(f"'{pkg}'", depends)
            self.assertNotIn(f"'{pkg}:", optdepends)
        self.assertIn(
            "systemctl --user enable --now vice.service",
            (REPO_ROOT / "vice-clipper.install").read_text(),
        )

    def test_xwayland_detection_tools_are_hard_dependencies(self) -> None:
        pkgbuild = (REPO_ROOT / "PKGBUILD").read_text()
        depends = re.search(r"depends=\((.*?)\)", pkgbuild, flags=re.S).group(1)

        for pkg in ("xdotool", "xorg-xprop", "wmctrl"):
            self.assertIn(f"'{pkg}'", depends)

        install_hint = (REPO_ROOT / "vice-clipper.install").read_text()
        self.assertIn(
            "systemctl --user import-environment WAYLAND_DISPLAY DISPLAY",
            install_hint,
        )


if __name__ == "__main__":
    unittest.main()
