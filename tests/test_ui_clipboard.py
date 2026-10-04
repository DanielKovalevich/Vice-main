"""Exercise the real clipboard helper with native and browser environments."""

from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class UIClipboardTests(unittest.TestCase):
    def test_clipboard_fallbacks(self):
        node = shutil.which("node")
        tsc = ROOT / "node_modules" / ".bin" / "tsc"
        if not node or not tsc.exists():
            self.skipTest("Node and UI dependencies are required")
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            compiled = subprocess.run(
                [str(tsc), str(ROOT / "ui-src/lib/clipboard.ts"), "--ignoreConfig",
                 "--outDir", str(out), "--module", "node16", "--target", "es2020",
                 "--moduleResolution", "node16", "--skipLibCheck"],
                cwd=ROOT, capture_output=True, text=True, timeout=60)
            self.assertEqual(compiled.returncode, 0, compiled.stdout + compiled.stderr)
            checked = subprocess.run(
                [node, str(ROOT / "tests/ui/clipboard.test.cjs"), str(out)],
                capture_output=True, text=True, timeout=30)
            self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)
