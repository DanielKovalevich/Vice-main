import re
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
INSTALL_SH = REPO_ROOT / "install.sh"


class InstallScriptTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.script = INSTALL_SH.read_text()

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
            r"dnf\)\s+local ffmpeg_devel.*?sudo dnf install -y (?P<packages>.*?) \|\| return 1",
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
        self.assertIn(
            "systemctl --user enable --now vice.service",
            (REPO_ROOT / "vice-clipper.install").read_text(),
        )


if __name__ == "__main__":
    unittest.main()
