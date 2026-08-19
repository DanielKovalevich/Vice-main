"""Run the UI's pure logic through Node.

The React UI is TypeScript, so its behaviour cannot be reached from Python
directly. The parts worth testing are pure and dependency-free, so they are
transpiled with the project's own tsc and exercised by tests/ui/logic.test.mjs.

Skipped, not failed, when Node or the UI dependencies are absent: the Python
side of Vice must stay testable on a machine that has never run npm install.
"""

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
UI_SRC = REPO_ROOT / "ui-src"
TEST_JS = REPO_ROOT / "tests" / "ui" / "logic.test.mjs"

# Pure modules: no React, no DOM, no network. Anything imported by these has to
# stay that way, or the transpiled output will not run under bare Node.
MODULES = [
    "lib/fireshare.ts",
    "lib/youtube.ts",
    "lib/clipGrouping.ts",
    "lib/editorExport.ts",
]

TSC = REPO_ROOT / "node_modules" / ".bin" / "tsc"


def _tsc() -> Path | None:
    for candidate in (TSC, TSC.with_suffix(".cmd")):
        if candidate.exists():
            return candidate
    return None


class UILogicTests(unittest.TestCase):
    """The UI rules that fail quietly rather than loudly."""

    def test_pure_ui_logic_behaves(self) -> None:
        node = shutil.which("node")
        if not node:
            self.skipTest("node is not installed")
        tsc = _tsc()
        if tsc is None:
            self.skipTest("UI dependencies are not installed; run npm install")

        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            result = subprocess.run(
                [
                    str(tsc),
                    *[str(UI_SRC / m) for m in MODULES],
                    "--ignoreConfig",
                    "--outDir",
                    str(out),
                    "--module",
                    "es2022",
                    "--target",
                    "es2022",
                    "--moduleResolution",
                    "bundler",
                    "--skipLibCheck",
                ],
                capture_output=True,
                text=True,
                timeout=180,
                cwd=REPO_ROOT,
            )
            # tsc reports type errors here too, which is a real failure: these
            # modules are meant to be self-contained.
            self.assertEqual(
                result.returncode,
                0,
                f"transpiling the pure UI modules failed:\n{result.stdout}\n{result.stderr}",
            )

            shutil.copy(TEST_JS, out / "logic.test.mjs")
            run = subprocess.run(
                [node, str(out / "logic.test.mjs")],
                capture_output=True,
                text=True,
                timeout=120,
            )
            self.assertEqual(
                run.returncode,
                0,
                f"UI logic checks failed:\n{run.stdout}\n{run.stderr}",
            )
            self.assertIn("OK", run.stdout)


class UILogicPurityTests(unittest.TestCase):
    """The tested modules have to stay runnable outside a browser."""

    def test_no_module_reaches_for_react_or_the_dom(self) -> None:
        for module in MODULES:
            source = (UI_SRC / module).read_text()
            for banned in ("from 'react'", "document.", "window."):
                self.assertNotIn(
                    banned,
                    source,
                    f"{module} uses {banned}, so it can no longer be tested under bare Node",
                )

    def test_the_test_file_covers_every_module(self) -> None:
        js = TEST_JS.read_text()
        for module in MODULES:
            name = Path(module).stem
            self.assertIn(f"./{name}.js", js, f"{name} is transpiled but never exercised")


if __name__ == "__main__":
    unittest.main()
