"""Run the UI's pure logic through Node.

Skipped, not failed, when Node or the UI dependencies are absent: the Python
side must stay testable on a machine that has never run npm install.
"""

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
UI_SRC = REPO_ROOT / "ui-src"
TEST_JS = REPO_ROOT / "tests" / "ui" / "logic.test.mjs"

# No React, no DOM, no network, so the transpiled output runs under bare Node.
MODULES = [
    "lib/fireshare.ts",
    "lib/youtube.ts",
    "lib/clipGrouping.ts",
    "lib/editorExport.ts",
]

TSC = REPO_ROOT / "node_modules" / ".bin" / "tsc"


def _tsc() -> "Path | None":
    for candidate in (TSC, TSC.with_suffix(".cmd")):
        if candidate.exists():
            return candidate
    return None


class UILogicTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
