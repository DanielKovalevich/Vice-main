import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
UI_INDEX = REPO_ROOT / "vice" / "ui" / "index.html"
HOME_JS = REPO_ROOT / "vice" / "ui" / "scripts" / "home.js"
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


if __name__ == "__main__":
    unittest.main()
