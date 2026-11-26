"""Checks for shipped UI assets, platform requirements, and data consistency.

Interaction behavior belongs in executable UI tests, not source substring checks.
"""

import json
import re
import shutil
import subprocess
import unittest
from functools import lru_cache
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
UI_SRC = REPO_ROOT / "ui-src"
UI_DIR = REPO_ROOT / "vice" / "ui"
UI_INDEX = UI_DIR / "index.html"
BUNDLE_JS = UI_DIR / "scripts" / "app.js"
BUNDLE_CSS = UI_DIR / "styles" / "app.css"
LOCALES = UI_SRC / "locales"


@lru_cache(maxsize=1)
def english_copy() -> dict:
    """en.json, the source of truth for every user-facing string."""
    return json.loads((LOCALES / "en.json").read_text())


def _leaf_strings(node) -> list:
    if isinstance(node, str):
        return [node]
    out = []
    for value in node.values():
        out.extend(_leaf_strings(value))
    return out


def _leaf_paths(node, prefix: str = "") -> list:
    """Every key path in a locale tree. A plural object counts as one leaf."""
    if isinstance(node, str) or "other" in node:
        return [prefix]
    out = []
    for key, value in node.items():
        out.extend(_leaf_paths(value, f"{prefix}.{key}" if prefix else key))
    return out


def read_source(*suffixes: str) -> str:
    """Every hand-written UI source file, concatenated."""
    wanted = suffixes or (".ts", ".tsx", ".css")
    parts = []
    for path in sorted(UI_SRC.rglob("*")):
        if path.is_file() and path.suffix in wanted:
            parts.append(path.read_text())
    return "\n".join(parts)


class BuiltUITests(unittest.TestCase):
    """Installers ship the prebuilt UI without running npm."""

    def test_built_bundle_is_committed(self) -> None:
        # Packaging installs these two files directly; nothing in the install
        # path runs a bundler, so a missing build breaks every user.
        self.assertTrue(BUNDLE_JS.is_file(), "the built app.js is not committed")
        self.assertTrue(BUNDLE_CSS.is_file(), "the built app.css is not committed")
        self.assertGreater(BUNDLE_JS.stat().st_size, 0)
        self.assertGreater(BUNDLE_CSS.stat().st_size, 0)

    def test_bundle_carries_every_locale(self) -> None:
        """A forgotten rebuild must not silently discard translation changes."""
        bundle = BUNDLE_JS.read_text()
        for path in sorted(LOCALES.glob("*.json")):
            strings = _leaf_strings(json.loads(path.read_text()))
            # Vite inlines the JSON, so a value reaches the bundle verbatim
            # unless it carries a character the emitter has to escape.
            checkable = [
                v for v in strings
                if v and len(v) >= 12 and not set(v) & set("`\\'\"") and "${" not in v
            ]
            missing = [v for v in checkable if v not in bundle]
            self.assertEqual(
                missing,
                [],
                f"the bundle is stale for {path.name}: "
                f"{len(missing)} of {len(checkable)} strings are missing, "
                f"first is {missing[0]!r}" if missing else "",
            )

    def test_index_only_loads_the_two_built_assets(self) -> None:
        index = UI_INDEX.read_text()
        scripts = re.findall(r'<script[^>]*src="([^"]+)"', index)
        styles = re.findall(r'<link[^>]*href="([^"]+)"', index)
        self.assertEqual(scripts, ["/scripts/app.js?v=__VICE_VERSION__"])
        self.assertEqual(styles, ["/styles/app.css?v=__VICE_VERSION__"])


class PlatformWorkaroundTests(unittest.TestCase):
    """Fixes for specific machines, each of which looks like dead code."""

    def test_dark_color_scheme_declared_for_native_dropdowns(self) -> None:
        self.assertIn(
            '<meta name="color-scheme" content="dark">', UI_INDEX.read_text()
        )

    def test_native_select_popups_get_system_colors(self) -> None:
        # Without these a native <select> popup renders white on white on
        # KDE Plasma 6 under Wayland (#85).
        css = read_source(".css")
        self.assertIn("select option", css)
        self.assertIn("MenuText", css)

    def test_every_clip_path_segment_is_url_encoded(self) -> None:
        """Regression test for #138, lost in the 2.8.0 rebuild: a slug is a
        filename, so `#`, `?`, `%` and `+` all change what the URL means."""
        api = (UI_SRC / "lib" / "api.ts").read_text()
        self.assertIn("encodeURIComponent", api)
        # Any interpolation straight into a path is the bug.
        for raw in ("${slug}", "${id}", "${jobId}"):
            self.assertNotIn(
                f"/{raw}", api,
                f"{raw} reaches a URL path without encoding",
            )


class OfflineTests(unittest.TestCase):
    """The daemon is expected to work with no network at all."""

    def test_fonts_are_local(self) -> None:
        css = (UI_SRC / "styles" / "base.css").read_text()
        for font in re.findall(r"url\(['\"]?(/fonts/[^)'\"]+)", css):
            self.assertTrue(
                (UI_DIR / font.lstrip("/")).is_file(),
                f"{font} is not shipped",
            )

    def test_the_bundle_fetches_nothing_from_the_internet(self) -> None:
        css = BUNDLE_CSS.read_text()
        self.assertNotIn("@import url(http", css)
        self.assertNotIn("fonts.googleapis", css)
        self.assertNotIn("fonts.gstatic", css)
        self.assertNotIn("cdn.jsdelivr", css)
        js = BUNDLE_JS.read_text()
        for host in ("fonts.googleapis", "cdn.jsdelivr", "unpkg.com", "cdnjs."):
            self.assertNotIn(host, js, f"the bundle reaches out to {host}")


class DesignTokenTests(unittest.TestCase):
    """Every token referenced must exist, or the declaration silently dies."""

    # Set outside the theme provider, with a fallback: by a component's inline
    # style, or by the pre-paint bootstrap in index.html.
    LOCAL = {"chip", "filled", "boot-accent"}

    def test_no_css_variable_is_referenced_that_does_not_exist(self) -> None:
        bundle = BUNDLE_CSS.read_text()
        used = set()
        for path in UI_SRC.rglob("*"):
            if path.suffix not in {".css", ".ts", ".tsx"} or not path.is_file():
                continue
            used.update(re.findall(r"var\(--([a-z0-9-]+)", path.read_text()))

        missing = sorted(
            name
            for name in used
            if name not in self.LOCAL
            and not name.startswith(("vice-", "ed-"))
            and f"--{name}:" not in bundle
        )
        # A declaration using an undefined variable is dropped entirely, so a
        # typo removes a border or a shadow with no error anywhere.
        self.assertEqual(missing, [], f"undefined design tokens: {missing}")


class BootThemeTests(unittest.TestCase):
    """The boot cover paints before the bundle, so it carries its own copy."""

    def test_inline_colours_match_the_generated_accents(self) -> None:
        index = UI_INDEX.read_text()
        accents = (UI_SRC / "theme" / "accents.ts").read_text()

        generated_bg = dict(re.findall(r"(\w+): \{[^}]*?bg: '(#\w{6})'", accents, re.S))
        generated_base = dict(re.findall(r"(\w+): \{\s*base: '(#\w{6})'", accents))

        for name, value in generated_bg.items():
            self.assertIn(
                f"{name}:'{value}'",
                index,
                f"index.html has a stale background for {name}; rerun npm run accents",
            )
        for name, value in generated_base.items():
            self.assertIn(f"{name}:'{value}'", index, f"index.html has a stale accent for {name}")


class DisabledUpdaterTests(unittest.TestCase):
    """The fork does not expose upstream's self-update API."""

    def test_the_update_check_stays_gone(self) -> None:
        """/api/update/check answers 404 now, so calling it always fails."""
        source = read_source(".ts", ".tsx")
        for gone in ("update/check", "checkUpdate", "update_available", "UpdateNotice"):
            self.assertNotIn(gone, source, f"{gone} is back")


class TranslationTests(unittest.TestCase):
    """Guards on the locale files.

    The failure mode worth catching is not a bad translation, it is English
    moving on and the other languages drifting behind it in silence.
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls.english = english_copy()
        cls.english_keys = set(_leaf_paths(cls.english))

    def _locales(self):
        for path in sorted(LOCALES.glob("*.json")):
            if path.stem != "en":
                yield path.stem, json.loads(path.read_text())

    def test_no_locale_carries_a_key_english_has_dropped(self) -> None:
        # An extra key means English was renamed and this file was not, so the
        # string is dead weight and whatever replaced it is untranslated.
        for name, tree in self._locales():
            extra = sorted(set(_leaf_paths(tree)) - self.english_keys)
            self.assertEqual(extra, [], f"{name}.json has keys en.json does not: {extra[:5]}")

    def test_plural_keys_carry_the_forms_english_needs(self) -> None:
        # A plural written as a flat string is right in English and wrong in
        # every language with more than two forms.
        def walk(node, prefix=""):
            if not isinstance(node, dict):
                return
            if "other" in node:
                self.assertIn("one", node, f"{prefix} has no singular form")
                self.assertTrue(
                    all(
                        form in ("zero", "one", "two", "few", "many", "other")
                        for form in node
                    ),
                    f"{prefix} has a form that is not a CLDR plural category: {sorted(node)}",
                )
                return
            for key, value in node.items():
                walk(value, f"{prefix}.{key}" if prefix else key)

        walk(self.english)

    def test_every_key_the_code_asks_for_exists(self) -> None:
        # t() renders a miss as the raw key, so a typo ships as "clips.allClips"
        # sitting in the UI where a heading should be. Only literal keys can be
        # checked; the few built from a variable are covered by their callers.
        literal = re.compile(r"""\bt\(\s*['"]([a-zA-Z0-9_.]+)['"]""")
        unknown = []
        for path in sorted(UI_SRC.rglob("*.ts")) + sorted(UI_SRC.rglob("*.tsx")):
            if path.is_relative_to(LOCALES):
                continue
            for key in literal.findall(path.read_text(encoding="utf-8")):
                if key not in self.english_keys:
                    unknown.append(f"{path.relative_to(UI_SRC)}: {key}")
        self.assertEqual(unknown, [], f"keys missing from en.json: {unknown[:8]}")


class AccentParityTests(unittest.TestCase):
    """The runtime derivation and the build-time generator must agree.

    Both keep producing plausible colours when they drift, so nothing else
    would catch it. This runs the five shipped seeds through the runtime code
    and diffs every role against what the generator actually wrote.

    Skipped without node_modules, which is how CI runs: the Python suite is the
    only thing CI installs, and the check belongs to whoever changes the theme.
    """

    def test_runtime_derivation_matches_the_generator(self) -> None:
        if not (REPO_ROOT / "node_modules" / "vite").exists():
            self.skipTest("node_modules is not installed")
        if not shutil.which("node"):
            self.skipTest("node is not on PATH")
        result = subprocess.run(
            ["node", "tools/verify-custom-accent.mjs"],
            cwd=REPO_ROOT, capture_output=True, text=True, timeout=180,
        )
        self.assertEqual(
            result.returncode, 0,
            "deriveAccent.ts has drifted from tools/derive-accents.mjs:\n"
            + result.stdout + result.stderr,
        )


if __name__ == "__main__":
    unittest.main()
