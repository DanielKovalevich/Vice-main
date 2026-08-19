"""Static assertions over the web UI.

The UI is a React and TypeScript source tree under ui-src/ that builds to two
committed files, vice/ui/scripts/app.js and vice/ui/styles/app.css. These
tests read the source rather than the bundle wherever they can, because the
bundle is minified and a failure in it says nothing useful.

What is worth asserting here is narrow. Behaviour is covered by driving the
real app; these are the things that are invisible until a user on a particular
machine hits them, plus the guards that have to hold on every file.
"""

import re
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
README = REPO_ROOT / "README.md"

# Spelled as an escape so this file does not itself trip the sweep guard below.
EM_DASH = "\u2014"


@lru_cache(maxsize=1)
def _git_ignored() -> frozenset:
    """Paths git is ignoring, which by definition never ship.

    Falls back to ignoring nothing outside a checkout, so a source tarball
    scans more rather than less.
    """
    try:
        out = subprocess.run(
            ["git", "ls-files", "--others", "--ignored", "--exclude-standard"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=30,
            check=True,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return frozenset()
    return frozenset(REPO_ROOT / line for line in out.splitlines() if line)


def read_source(*suffixes: str) -> str:
    """Every hand-written UI source file, concatenated."""
    wanted = suffixes or (".ts", ".tsx", ".css")
    parts = []
    for path in sorted(UI_SRC.rglob("*")):
        if path.is_file() and path.suffix in wanted:
            parts.append(path.read_text())
    return "\n".join(parts)


class UISourcePresenceTests(unittest.TestCase):
    """The source tree exists and is what the bundle is built from."""

    def test_ui_source_tree_is_present(self) -> None:
        self.assertTrue(UI_SRC.is_dir(), "ui-src/ is missing")
        self.assertTrue((UI_SRC / "main.tsx").is_file())
        for screen in ("Home", "Clips", "Settings", "Editor", "About"):
            self.assertTrue(
                (UI_SRC / "screens" / f"{screen}.tsx").is_file(),
                f"{screen} screen is missing",
            )

    def test_built_bundle_is_committed(self) -> None:
        # Packaging installs these two files directly; nothing in the install
        # path runs a bundler, so a missing build breaks every user.
        self.assertTrue(BUNDLE_JS.is_file(), "the built app.js is not committed")
        self.assertTrue(BUNDLE_CSS.is_file(), "the built app.css is not committed")
        self.assertGreater(BUNDLE_JS.stat().st_size, 50_000)
        self.assertGreater(BUNDLE_CSS.stat().st_size, 20_000)

    def test_bundle_carries_the_current_copy(self) -> None:
        """Catches a source edit that was never rebuilt.

        The committed bundle is what ships, so copy that exists only in
        ui-src/ would be invisible to every user.
        """
        bundle = BUNDLE_JS.read_text()
        for phrase in (
            "Double-tap to start or stop a full recording",
            "Discord Rich Presence is on",
            "Everything saved",
            "Nothing at the playhead",
            "Danger zone",
            "Loops the selection",
            "not being reported right now",
        ):
            self.assertIn(phrase, bundle, f"the bundle is stale: {phrase!r} is missing")

    def test_index_only_loads_the_two_built_assets(self) -> None:
        index = UI_INDEX.read_text()
        scripts = re.findall(r'<script[^>]*src="([^"]+)"', index)
        styles = re.findall(r'<link[^>]*href="([^"]+)"', index)
        self.assertEqual(scripts, ["/scripts/app.js?v=__VICE_VERSION__"])
        self.assertEqual(styles, ["/styles/app.css?v=__VICE_VERSION__"])

    def test_assets_carry_the_cache_busting_token(self) -> None:
        # share.py rewrites ?v=__VICE_VERSION__ to a per-build fingerprint and
        # then serves the assets immutable for a year. Without the token a
        # user keeps the previous build's UI after an upgrade.
        index = UI_INDEX.read_text()
        self.assertEqual(index.count("?v=__VICE_VERSION__"), 2)


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

    def test_saved_but_unlisted_values_survive_a_save(self) -> None:
        # Dropping an unlisted display to Auto wrote display=null on the next
        # save and destroyed a hand-set monitor, which is the only way to
        # reach one gpu-screen-recorder will not enumerate (#160).
        settings = (UI_SRC / "screens" / "Settings.tsx").read_text()
        self.assertEqual(settings.count("(saved)"), 3, "all three pickers must keep a saved value")
        self.assertIn("not being reported right now", settings)

    def test_h265_clips_ask_for_an_h264_preview_proxy(self) -> None:
        playback = (UI_SRC / "lib" / "playback.ts").read_text()
        self.assertIn("proxy=1", playback)
        self.assertIn("hevc", playback)
        self.assertIn("HEVC_SUPPORTED", playback)

    def test_missing_h264_decoder_is_reported_not_hidden(self) -> None:
        # A WebEngine build without the codec drops the video track in
        # silence, leaving a grey rectangle and no explanation (#79).
        playback = (UI_SRC / "lib" / "playback.ts").read_text()
        self.assertIn("videoWidth === 0", playback)
        self.assertIn("no H.264 decoder", playback)

    def test_native_window_is_detected_before_pywebview_is_injected(self) -> None:
        # window.pywebview only exists after DOMContentLoaded, which is too
        # late to get the quit row right on the first paint.
        env = (UI_SRC / "lib" / "env.ts").read_text()
        self.assertIn("native", env)
        self.assertIn("'1'", env)
        self.assertIn("pywebview", env)

    def test_clipboard_falls_back_when_the_async_api_is_unavailable(self) -> None:
        clipboard = (UI_SRC / "lib" / "clipboard.ts").read_text()
        self.assertIn("pywebview", clipboard)
        self.assertIn("execCommand", clipboard)


class EffectsProbeTests(unittest.TestCase):
    """The compositor probe's constants were tuned against real hardware."""

    def setUp(self) -> None:
        self.effects = (UI_SRC / "lib" / "effects.ts").read_text()

    def test_probe_constants_are_intact(self) -> None:
        self.assertIn("SLOW_FRAME_MS = 42", self.effects)
        self.assertIn("PROBE_SAMPLES = 48", self.effects)
        self.assertIn("PROBE_WARMUP = 4", self.effects)

    def test_probe_uses_the_median_not_the_mean(self) -> None:
        self.assertIn("gaps.sort", self.effects)
        self.assertIn("gaps.length >> 1", self.effects)

    def test_probe_measures_with_effects_on(self) -> None:
        # Probing while .perf-low is on measures the cheap UI, concludes the
        # machine is fast and turns everything back on, which is a mode that
        # flips on every launch.
        self.assertIn("classList.remove('perf-low')", self.effects)

    def test_all_three_modes_are_offered(self) -> None:
        self.assertIn("'auto', 'full', 'reduced'", self.effects)


class UICopyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source = read_source(".tsx", ".ts")
        cls.readme = README.read_text()

    def test_tutorial_reflects_current_workflows(self) -> None:
        self.assertIn("Double-tap to start or stop a full recording", self.source)
        self.assertIn("mark a\n              highlight", self.source)
        self.assertIn("trim the best moment", self.source)
        self.assertIn("Vice keeps recording", self.source)
        self.assertIn("Discord Rich Presence is on", self.source)

    def test_discord_copy_does_not_say_off_by_default(self) -> None:
        # DiscordConfig.enabled defaults to True.
        copy = self.source + "\n" + self.readme
        self.assertIn("On by default", copy)
        self.assertNotIn("off by default", copy.lower())

    def test_durations_in_copy_come_from_the_config(self) -> None:
        # The lede used to hard-code 20 seconds and was wrong for anyone who
        # had changed it.
        home = (UI_SRC / "screens" / "Home.tsx").read_text()
        self.assertIn("clip_duration", home)
        self.assertIn("{formatDuration(clipDuration, true)}", home)

    def test_local_only_share_links_say_so(self) -> None:
        # A LAN address looks identical to a real share link right up until a
        # friend cannot open it (#105).
        share = (UI_SRC / "lib" / "share.ts").read_text()
        self.assertIn("local only", share)
        self.assertIn("cloudflared", share)

    def test_a_clip_with_no_detected_game_says_so(self) -> None:
        # The tag line used to render nothing, so the card quietly changed
        # height depending on whether detection had found anything.
        card = (UI_SRC / "components" / "ClipCard.tsx").read_text()
        self.assertIn("'Untagged'", card)
        self.assertIn("data-untagged", card)

    def test_unreadable_clips_are_marked_and_left_alone(self) -> None:
        card = (UI_SRC / "components" / "ClipCard.tsx").read_text()
        self.assertIn("Unreadable", card)
        self.assertIn("still on\n            disk", card)


class SettingsCoverageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.settings = (UI_SRC / "screens" / "Settings.tsx").read_text()
        cls.draft = (UI_SRC / "lib" / "settingsDraft.ts").read_text()

    def test_every_section_is_present(self) -> None:
        for section in (
            "recording",
            "audio",
            "hotkeys",
            "storage",
            "sharing",
            "fireshare",
            "youtube",
            "discord",
            "appearance",
            "advanced",
        ):
            self.assertIn(f"'{section}'", self.settings, f"the {section} section is missing")

    def test_every_config_key_the_daemon_reads_is_written(self) -> None:
        for key in (
            "buffer_duration",
            "clip_duration",
            "fps",
            "display",
            "follow_mouse_display",
            "resolution",
            "container",
            "encoder",
            "color_depth",
            "backend",
            "capture_audio",
            "gsr_replay_storage",
            "capture_microphone",
            "microphone_source",
            "microphone_mono",
            "desktop_volume",
            "microphone_volume",
            "wf_microphone_strategy",
            "gsr_audio_source",
            "audio_tracks",
            "audio_tracks_mix_first",
            "gsr_args",
            "clip_presets",
            "disable_while_focused",
            "tag_clips_with_game",
            "auto_playlist_by_game",
            "clip_name_template",
            "cloudflare_tunnel",
            "sound_volume",
            "hardware_video_decode",
            "client_id_override",
            "custom_games",
            # The fork's own sections.
            "base_url",
            "default_privacy",
            "default_folder",
            "default_title_template",
            "require_https",
            "executable",
            "connectors",
        ):
            self.assertIn(key, self.draft, f"{key} is never written back")

    def test_all_five_custom_sounds_are_offered(self) -> None:
        for key in (
            "clip_sound",
            "clip_failed_sound",
            "session_start_sound",
            "session_end_sound",
            "highlight_sound",
        ):
            self.assertIn(key, self.draft)

    def test_encoder_dropdown_offers_av1(self) -> None:
        self.assertIn("av1_nvenc", self.settings)
        self.assertIn("av1_vaapi", self.settings)

    def test_duration_sliders_reach_thirty_minutes(self) -> None:
        self.assertEqual(self.settings.count("max={1800}"), 2)

    def test_resolution_allows_a_custom_value(self) -> None:
        self.assertIn("'custom'", self.settings)
        self.assertIn(r"^\d{2,5}x\d{2,5}$", self.draft)

    def test_buffer_is_raised_to_cover_the_longest_clip_key(self) -> None:
        self.assertIn("requiredBuffer", self.draft)
        self.assertIn("clipPresets.map", self.draft)

    def test_clip_name_preview_mirrors_the_daemon(self) -> None:
        self.assertIn("$n", self.draft)
        self.assertIn("$date", self.draft)
        self.assertIn("$time", self.draft)
        self.assertIn("$game", self.draft)

    def test_audio_track_conflict_is_explained(self) -> None:
        # With desktop audio off the recorder keeps only microphone sources,
        # so a game track vanishes with nothing saying why (#137).
        tracks = (UI_SRC / "components" / "settings" / "AudioTracks.tsx").read_text()
        self.assertIn("tracksLostWithoutDesktopAudio", tracks)
        self.assertIn("will not be recorded", tracks)


class EditorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.engine = (UI_SRC / "engine" / "editor.ts").read_text()
        cls.screen = (UI_SRC / "screens" / "Editor.tsx").read_text()

    def test_playback_pool_keeps_three_elements_per_track(self) -> None:
        # With two, the outgoing clip and the preloaded one fought over the
        # same element and reassigned its src every frame.
        self.assertIn("make(), make(), make()", self.engine)

    def test_clock_follows_the_master_video(self) -> None:
        # Chasing wall time forced a corrective seek every few frames.
        self.assertIn("master", self.engine)
        self.assertIn("m.cur.currentTime", self.engine)

    def test_warm_start_constants_are_intact(self) -> None:
        self.assertIn("ED_WARM_MS = 350", self.engine)
        self.assertIn("ED_PRELOAD = 2.0", self.engine)
        self.assertIn("ED_DRIFT = 0.15", self.engine)

    def test_all_six_transitions_are_offered(self) -> None:
        constants = (UI_SRC / "engine" / "editorConstants.ts").read_text()
        for fx in ("crossfade", "fadeblack", "fadewhite", "dipaccent", "blurdis", "slide"):
            self.assertIn(f"id: '{fx}'", constants)

    def test_transition_preview_matches_the_export_filters(self) -> None:
        self.assertIn("xfade hblur", self.engine)
        self.assertIn("xfade slideleft", self.engine)

    def test_editor_text_tool_keeps_all_three_fonts(self) -> None:
        constants = (UI_SRC / "engine" / "editorConstants.ts").read_text()
        for font in ("Geist", "Inter", "JetBrains Mono"):
            self.assertIn(font, constants)

    def test_export_offers_every_location(self) -> None:
        for location in ("library", "videos", "custom"):
            self.assertIn(f"'{location}'", self.screen)

    def test_leaving_the_editor_releases_the_decoders(self) -> None:
        self.assertIn("releasePool", self.engine)
        self.assertIn("removeAttribute('src')", self.engine)


class OfflineTests(unittest.TestCase):
    """The daemon is expected to work with no network at all."""

    def test_fonts_are_local(self) -> None:
        css = (UI_SRC / "styles" / "base.css").read_text()
        self.assertEqual(css.count("@font-face"), 4)
        for font in ("Figtree", "Geist", "Inter", "JetBrainsMono"):
            self.assertIn(f"/fonts/{font}.woff2", css)
        for font in ("Figtree", "Geist", "Inter", "JetBrainsMono"):
            self.assertTrue(
                (UI_DIR / "fonts" / f"{font}.woff2").is_file(),
                f"{font}.woff2 is not shipped",
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

    def test_locally_defined_variables_carry_a_fallback(self) -> None:
        for name in self.LOCAL:
            for path in UI_SRC.rglob("*.css"):
                for hit in re.findall(rf"var\(--{name}[^)]*\)", path.read_text()):
                    self.assertIn(",", hit, f"{hit} in {path.name} needs a fallback")


class BootThemeTests(unittest.TestCase):
    """The boot cover paints before the bundle, so it carries its own copy."""

    def test_inline_colours_match_the_generated_accents(self) -> None:
        index = UI_INDEX.read_text()
        accents = (UI_SRC / "theme" / "accents.ts").read_text()

        generated_bg = dict(re.findall(r"(\w+): \{[^}]*?bg: '(#\w{6})'", accents, re.S))
        generated_base = dict(re.findall(r"(\w+): \{\s*base: '(#\w{6})'", accents))
        self.assertEqual(len(generated_bg), 5, "expected five accents")

        for name, value in generated_bg.items():
            self.assertIn(
                f"{name}:'{value}'",
                index,
                f"index.html has a stale background for {name}; rerun npm run accents",
            )
        for name, value in generated_base.items():
            self.assertIn(f"{name}:'{value}'", index, f"index.html has a stale accent for {name}")

    def test_the_boot_cover_can_set_the_wordmark_before_the_bundle(self) -> None:
        # The cover paints before the bundle parses. A linked font would flash a
        # fallback on the one screen whose job is hiding load time, so the face
        # is inlined in the document head as a data URI.
        index = UI_INDEX.read_text()
        self.assertIn("@font-face", index, "the wordmark face must be declared in index.html")
        self.assertIn("data:font/woff2;base64,", index, "the face must be inlined, not linked")
        self.assertIn("Syne VICE", index)
        self.assertIn('class="boot-word wordmark"', index)

        css = read_source(".css")
        self.assertIn("'Syne VICE'", css, "the .wordmark class must use the inlined family")

    def test_the_wordmark_is_used_in_three_places_only(self) -> None:
        # It is a logo, not a heading style. Body and heading text stay Figtree.
        users = [
            p.name
            for p in UI_SRC.rglob("*.tsx")
            if "<Wordmark" in p.read_text() and p.name != "Wordmark.tsx"
        ]
        self.assertEqual(sorted(users), ["About.tsx", "SideNav.tsx"])

    def test_the_cover_shows_that_something_is_happening(self) -> None:
        index = UI_INDEX.read_text()
        self.assertIn("boot-orbit", index)
        self.assertIn("boot-bar", index)
        css = read_source(".css")
        self.assertIn("@keyframes boot-spin", css)
        self.assertIn("@keyframes boot-slide", css)

    def test_the_cover_is_reachable_without_javascript_running(self) -> None:
        # It is markup in index.html on purpose: a cover the bundle has to
        # render cannot cover the time before the bundle parses.
        index = UI_INDEX.read_text()
        boot = index[index.index('<div id="boot">'):]
        # The wordmark is set in uppercase, so match the name case-insensitively
        # rather than pinning how it happens to be cased.
        self.assertIn("vice", boot.lower())


class TypographyTests(unittest.TestCase):
    def test_nothing_is_set_below_eleven_pixels(self) -> None:
        offenders = []
        for path in sorted(UI_SRC.rglob("*.css")):
            for line_no, line in enumerate(path.read_text().splitlines(), 1):
                for size in re.findall(r"font-size:\s*([0-9.]+)px", line):
                    if float(size) < 11:
                        offenders.append(f"{path.name}:{line_no} ({size}px)")
        self.assertEqual(offenders, [], f"type below 11px: {offenders}")


class WebSocketCoverageTests(unittest.TestCase):
    """Every message the daemon broadcasts has to land somewhere."""

    # Handling is runtime code: a case label, a comparison, or membership of
    # the array the narrowing helper reads. A name appearing only in the
    # WsMessage union proves the type exists, not that anything acts on it, so
    # the union is stripped before searching.
    UNION_RE = re.compile(r"export type WsMessage =.*?;\n", re.S)

    def _handling_code(self) -> str:
        types = self.UNION_RE.sub("", (UI_SRC / "lib" / "types.ts").read_text())
        return "\n".join(
            [
                (UI_SRC / "state" / "store.tsx").read_text(),
                (UI_SRC / "screens" / "Editor.tsx").read_text(),
                (UI_SRC / "components" / "FireShareModal.tsx").read_text(),
                (UI_SRC / "components" / "YouTubeModal.tsx").read_text(),
                types,
            ]
        )

    def test_the_union_is_actually_stripped(self) -> None:
        """Guards the test above: if the union stops matching, it goes soft."""
        raw = (UI_SRC / "lib" / "types.ts").read_text()
        self.assertIn("export type WsMessage =", raw)
        self.assertNotIn("export type WsMessage =", self.UNION_RE.sub("", raw))

    def test_every_broadcast_type_is_handled(self) -> None:
        handled = self._handling_code()
        for message in (
            "clip_saved",
            "clip_deleted",
            "playlists_changed",
            "clip_saving",
            "clip_error",
            "tunnel_url",
            "tunnel_error",
            "session_start",
            "session_stop",
            "session_highlight",
            "export_progress",
            "export_done",
            "export_error",
            "editor_project_changed",
            "game_status",
            "fireshare_publish_started",
            "fireshare_publish_progress",
            "fireshare_publish_processing",
            "fireshare_publish_ready",
            "fireshare_publish_failed",
            "fireshare_publish_stale",
            "youtube_upload_started",
            "youtube_upload_done",
            "youtube_upload_error",
        ):
            self.assertIn(message, handled, f"{message} is unhandled")

    def test_the_update_check_stays_gone(self) -> None:
        """/api/update/check answers 404 now, so calling it always fails."""
        source = read_source(".ts", ".tsx")
        for gone in ("update/check", "checkUpdate", "update_available", "UpdateNotice"):
            self.assertNotIn(gone, source, f"{gone} is back")


class NoEmDashesAnywhereTests(unittest.TestCase):
    """No em-dash may reach a shipped file. Andrew's rule, and a tell."""

    SKIP_DIRS = {
        ".git",
        "__pycache__",
        ".venv",
        "venv",
        "node_modules",
        "dist",
        ".mypy_cache",
        ".pytest_cache",
    }
    SHIPPED_SUFFIXES = {
        ".py",
        ".js",
        ".ts",
        ".tsx",
        ".mts",
        ".mjs",
        ".css",
        ".html",
        ".md",
        ".sh",
        ".toml",
        ".json",
        ".service",
        ".desktop",
        ".install",
        ".rules",
    }
    # The two build outputs. Minified dependency strings are outside anyone's
    # control here, and the sources they come from are scanned instead.
    GENERATED = {BUNDLE_JS, BUNDLE_CSS}

    def _shipped_files(self):
        ignored = _git_ignored()
        for path in REPO_ROOT.rglob("*"):
            if not path.is_file():
                continue
            if any(part in self.SKIP_DIRS for part in path.parts):
                continue
            if path in self.GENERATED or path in ignored:
                continue
            if path.suffix not in self.SHIPPED_SUFFIXES:
                continue
            yield path

    def test_no_shipped_file_contains_an_em_dash(self) -> None:
        offenders = []
        for path in self._shipped_files():
            try:
                text = path.read_text()
            except (UnicodeDecodeError, OSError):
                continue
            if EM_DASH in text:
                line = next(
                    (i for i, ln in enumerate(text.splitlines(), 1) if EM_DASH in ln),
                    0,
                )
                offenders.append(f"{path.relative_to(REPO_ROOT)}:{line}")
        self.assertEqual(offenders, [], f"em-dash found in: {', '.join(offenders)}")

    def test_the_guard_actually_looks_at_the_source(self) -> None:
        # A guard that silently stops scanning is worse than none.
        scanned = list(self._shipped_files())
        self.assertGreater(len(scanned), 60)
        names = {p.name for p in scanned}
        self.assertIn("main.tsx", names)
        self.assertIn("Settings.tsx", names)
        self.assertIn("editor.ts", names)
        self.assertIn("share.py", names)
        self.assertIn("README.md", names)


if __name__ == "__main__":
    unittest.main()
