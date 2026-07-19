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

    def test_buffer_viz_uses_css_animation_not_js_timer(self) -> None:
        # A perpetual JS style-mutation loop leaked renderer memory while
        # the window sat open (#83); the bars must animate via CSS.
        self.assertNotIn("setInterval", self.home_js)
        self.assertIn("buffer-pulse", HOME_CSS.read_text())


if __name__ == "__main__":
    unittest.main()
