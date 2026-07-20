import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
UI_INDEX = REPO_ROOT / "vice" / "ui" / "index.html"
HOME_JS = REPO_ROOT / "vice" / "ui" / "scripts" / "home.js"
SETTINGS_CSS = REPO_ROOT / "vice" / "ui" / "styles" / "settings.css"
HOME_CSS = REPO_ROOT / "vice" / "ui" / "styles" / "home.css"
README = REPO_ROOT / "README.md"


class UIStaticCopyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.index = UI_INDEX.read_text()
        cls.home_js = HOME_JS.read_text()
        cls.readme = README.read_text()

    def test_tutorial_reflects_current_workflows(self) -> None:
        copy = self.index + "\n" + self.home_js

        self.assertIn("Double-tap to start or stop a full recording", copy)
        self.assertIn("Tap once during a session to mark a highlight", copy)
        self.assertIn("trim the best moment", copy)
        self.assertIn("share a link", copy)
        self.assertIn("Vice keeps recording", copy)
        self.assertIn("Discord Rich Presence is on by default", copy)

    def test_discord_copy_no_longer_says_off_by_default(self) -> None:
        copy = self.index + "\n" + self.readme

        self.assertIn("On by default", copy)
        self.assertNotIn("off by default", copy.lower())

    def test_dark_color_scheme_declared_for_native_dropdowns(self) -> None:
        # Without these, native <select> popups render white-on-white on
        # KDE Plasma 6 / Wayland (#85).
        self.assertIn('<meta name="color-scheme" content="dark">', self.index)
        css = SETTINGS_CSS.read_text()
        self.assertIn("select option", css)
        self.assertIn("MenuText", css)

    def test_manual_copy_modal_exists(self) -> None:
        self.assertIn('id="manual-copy-modal"', self.index)
        self.assertIn('id="manual-copy-text"', self.index)

    def test_software_render_mode_drops_heavy_effects(self) -> None:
        # vice-app appends sw=1 when relaunched with software compositing;
        # the UI must drop backdrop blurs and ambient effects in that mode.
        base_css = (REPO_ROOT / "vice" / "ui" / "styles" / "base.css").read_text()
        state_js = (REPO_ROOT / "vice" / "ui" / "scripts" / "state.js").read_text()
        init_js = (REPO_ROOT / "vice" / "ui" / "scripts" / "init.js").read_text()

        self.assertIn(".perf-low", base_css)
        self.assertIn("backdrop-filter: none", base_css)
        self.assertIn("IS_SOFTWARE_RENDER", state_js)
        self.assertIn("perf-low", init_js)

    def test_encoder_dropdown_offers_av1(self) -> None:
        self.assertIn('value="av1_nvenc"', self.index)
        self.assertIn('value="av1_vaapi"', self.index)

    def test_pick_keeps_unknown_select_values(self) -> None:
        # A hand-edited config value (e.g. encoder = "av1" before it was in
        # the dropdown) must not blank the select and get wiped on save (#109).
        settings_js = (REPO_ROOT / "vice" / "ui" / "scripts" / "settings.js").read_text()
        self.assertIn("(custom)", settings_js)

    def test_duration_sliders_allow_thirty_minutes(self) -> None:
        self.assertIn('id="s-dur" min="5" max="1800"', self.index)
        self.assertIn('id="s-buf" min="30" max="1800"', self.index)

    def test_replay_storage_setting_exists(self) -> None:
        self.assertIn('id="s-replay-storage"', self.index)
        settings_js = (REPO_ROOT / "vice" / "ui" / "scripts" / "settings.js").read_text()
        self.assertIn("gsr_replay_storage", settings_js)
        self.assertIn("updateBufferNote", settings_js)

    def test_desktop_audio_select_groups_sources_and_warns_on_mic(self) -> None:
        settings_js = (REPO_ROOT / "vice" / "ui" / "scripts" / "settings.js").read_text()
        self.assertIn("optgroup", settings_js)
        self.assertIn("onDesktopSourceChange", settings_js)
        self.assertIn("microphone input", settings_js)

    def test_volume_sliders_exist_for_desktop_and_mic(self) -> None:
        self.assertIn('id="s-vol-desktop"', self.index)
        self.assertIn('id="s-vol-mic"', self.index)
        # Mic capture must be toggleable from the Audio settings too, or the
        # mic volume slider is undiscoverable.
        self.assertIn('id="settings-mic-toggle"', self.index)
        settings_js = (REPO_ROOT / "vice" / "ui" / "scripts" / "settings.js").read_text()
        self.assertIn("desktop_volume", settings_js)
        self.assertIn("microphone_volume", settings_js)
        self.assertIn("syncVolumeRows", settings_js)

    def test_trim_preview_loop_is_wired(self) -> None:
        self.assertIn('id="trim-preview-btn"', self.index)
        trim_js = (REPO_ROOT / "vice" / "ui" / "scripts" / "trim.js").read_text()
        self.assertIn("toggleTrimPreview", trim_js)
        self.assertIn("onTrimTimeUpdate", trim_js)
        init_js = (REPO_ROOT / "vice" / "ui" / "scripts" / "init.js").read_text()
        self.assertIn("onTrimTimeUpdate", init_js)
        self.assertIn("onTrimVideoEnded", init_js)

    def test_resolution_and_fps_allow_custom_values(self) -> None:
        self.assertIn('value="custom"', self.index)
        self.assertIn('id="s-res-custom"', self.index)
        for fps in ("50", "120", "144"):
            self.assertIn(f'value="{fps}"', self.index)
        settings_js = (REPO_ROOT / "vice" / "ui" / "scripts" / "settings.js").read_text()
        self.assertIn("resolvedResolution", settings_js)

    def test_settings_rail_covers_every_section(self) -> None:
        import re
        rails = re.findall(r'data-rail="(\w+)"', self.index)
        sections = re.findall(r'data-section="(\w+)"', self.index)
        self.assertEqual(rails, sections)
        # Audio settings live in their own section instead of being buried
        # at the bottom of Recording.
        self.assertIn("audio", rails)
        self.assertEqual(rails[0], "recording")

    def test_ambient_motion_uses_css_animation_not_js_timer(self) -> None:
        # A perpetual JS style-mutation loop leaked renderer memory while
        # the window sat open (#83); ambient motion must run as CSS.
        self.assertNotIn("setInterval", self.home_js)
        base_css = (REPO_ROOT / "vice" / "ui" / "styles" / "base.css").read_text()
        self.assertIn("vgDrift", base_css)
        self.assertIn("prefers-reduced-motion", base_css)

    def test_sidebar_shell_replaces_top_nav(self) -> None:
        self.assertIn('id="sidebar"', self.index)
        self.assertIn("PLAYLISTS", self.index)
        self.assertIn('id="sidebar-playlists"', self.index)
        self.assertIn('id="search-input"', self.index)
        self.assertNotIn("nav-indicator", self.index)

    def test_playlists_ui_is_wired(self) -> None:
        self.assertIn('id="new-playlist-modal"', self.index)
        self.assertIn('id="tut-page-2"', self.index)
        self.assertIn('id="home-playlists"', self.index)
        self.assertIn('id="playlist-header-tile"', self.index)
        self.assertIn('id="playlist-delete-btn"', self.index)
        playlists_js = (REPO_ROOT / "vice" / "ui" / "scripts" / "playlists.js").read_text()
        self.assertIn("/api/playlists", playlists_js)
        self.assertIn("openPlaylistMenu", playlists_js)

    def test_most_viewed_and_dynamic_home_rows_are_wired(self) -> None:
        self.assertIn('id="home-viewed-row"', self.index)
        self.assertIn("homeRowCapacity", self.home_js)
        viewer_js = (REPO_ROOT / "vice" / "ui" / "scripts" / "viewer.js").read_text()
        self.assertIn("recordClipView", viewer_js)
        self.assertIn("/view", viewer_js)

    def test_playlist_edit_is_wired(self) -> None:
        self.assertIn('id="playlist-edit-btn"', self.index)
        playlists_js = (REPO_ROOT / "vice" / "ui" / "scripts" / "playlists.js").read_text()
        self.assertIn("openEditPlaylistModal", playlists_js)
        self.assertIn("savePlaylistEdits", playlists_js)

    def test_mini_player_exists_and_shares_viewer_video(self) -> None:
        self.assertIn('id="player-bar"', self.index)
        player_js = (REPO_ROOT / "vice" / "ui" / "scripts" / "player.js").read_text()
        self.assertIn("viewer-video", player_js)
        self.assertIn("closePlayerBar", player_js)

    def test_new_assets_carry_version_token(self) -> None:
        # UI assets are cached immutable for a year; any reference without
        # the version token would serve stale files forever after upgrade.
        for ref in (
            "/styles/sidebar.css?v=__VICE_VERSION__",
            "/styles/playlists.css?v=__VICE_VERSION__",
            "/styles/player.css?v=__VICE_VERSION__",
            "/scripts/playlists.js?v=__VICE_VERSION__",
            "/scripts/player.js?v=__VICE_VERSION__",
        ):
            self.assertIn(ref, self.index)


if __name__ == "__main__":
    unittest.main()
