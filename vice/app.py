"""
Vice desktop app — opens the web UI in a native pywebview window.

Launched via `vice-app` (app icon, launcher, or command line).

Behaviour:
  • Starts the Vice daemon subprocess if it isn't already running.
  • Waits for the HTTP server to be ready, then opens a native window.
  • Exposes a JS API so the UI can call vice.quit() to stop the daemon
    and close the window cleanly.
  • Closing the window without vice.quit() keeps recording running.
  • Sending SIGTERM to vice-app (for example: killall vice-app) now
    forwards a clean stop request to the daemon before exit.
  • Re-launching vice-app when the daemon is already running just opens
    a new window connected to the existing session.

Falls back to xdg-open (browser) if pywebview is not installed.
Errors are logged to ~/.local/share/vice/vice-app.log when running
without a terminal (e.g. from the app launcher).
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

from . import __version__
from .runtime import actual_home_dir, normalize_runtime_environment

SOCKET_FILE = Path("/tmp/vice/vice.sock")
PID_FILE    = Path("/tmp/vice/vice.pid")
WINDOW_TITLE = "Vice"
LOG_FILE = actual_home_dir() / ".local" / "share" / "vice" / "vice-app.log"
DEBUG_LOG_FILE = actual_home_dir() / ".local" / "share" / "vice" / "vice-debug.log"
DAEMON_LOG_FILE = actual_home_dir() / ".local" / "share" / "vice" / "vice.log"
DAEMON_STDERR_LOG_FILE = actual_home_dir() / ".local" / "share" / "vice" / "vice-daemon-stderr.log"

DEBUG_MODE = False  # toggled by main() when --debug is on the command line.


# ── logging ───────────────────────────────────────────────────────────────────

def _setup_logging(debug: bool = False) -> None:
    """Log to file when stdout is not a TTY (i.e. launched from app menu).

    In debug mode: add a second verbose file handler at ~/.local/share/vice/
    vice-debug.log, capturing DEBUG-level logs from every logger — including
    JS bridge calls and the clipboard subprocess trace.
    """
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    handlers: list[logging.Handler] = [
        logging.FileHandler(LOG_FILE),
    ]
    if sys.stdout.isatty() or debug:
        handlers.append(logging.StreamHandler(sys.stderr))
    if debug:
        dbg = logging.FileHandler(DEBUG_LOG_FILE, mode="w")  # truncate each run
        dbg.setLevel(logging.DEBUG)
        dbg.setFormatter(logging.Formatter(
            "%(asctime)s [%(threadName)s] %(levelname)s %(name)s "
            "%(filename)s:%(lineno)d — %(message)s"
        ))
        handlers.append(dbg)
    logging.basicConfig(
        level=logging.DEBUG if debug else logging.INFO,
        format="%(asctime)s [vice-app] %(levelname)s: %(message)s",
        handlers=handlers,
    )


log = logging.getLogger("vice-app")


def _handle_app_terminate(signum: int, _frame) -> None:
    """Stop daemon when vice-app is terminated externally."""
    log.info("Received signal %s, stopping daemon before exit", signum)
    try:
        _stop_daemon()
    finally:
        raise SystemExit(0)


# ── helpers ───────────────────────────────────────────────────────────────────

def _vice_cmd() -> list[str]:
    """Return the command to run the vice daemon.

    Tries (in order):
      1. Absolute ~/.local/bin/vice  (covers both pip-user and venv symlink)
      2. shutil.which("vice")        (works if PATH is set correctly)
      3. sys.executable -m vice.main (fallback using same Python as vice-app)
    """
    user_bin = actual_home_dir() / ".local" / "bin" / "vice"
    if user_bin.exists():
        return [str(user_bin)]
    found = shutil.which("vice")
    if found:
        return [found]
    # Last resort: run as a module with the same Python interpreter
    return [sys.executable, "-m", "vice.main"]


def _daemon_responds(timeout: float = 1.0) -> bool:
    """Return True when the Unix socket accepts an IPC request."""
    return _daemon_status(timeout=timeout) is not None


def _daemon_status(timeout: float = 1.0) -> dict | None:
    """Return daemon IPC status JSON, or None when the socket is unusable."""
    if not SOCKET_FILE.exists():
        return None

    async def _probe() -> dict | None:
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_unix_connection(str(SOCKET_FILE)),
                timeout=timeout,
            )
            writer.write(b"status\n")
            await writer.drain()
            resp = await asyncio.wait_for(reader.readline(), timeout=timeout)
            writer.close()
            await writer.wait_closed()
            if not resp:
                return None
            import json
            return json.loads(resp)
        except Exception:
            return None

    return asyncio.run(_probe())


def _start_daemon() -> None:
    """Launch the daemon as a detached background process (no-op if running)."""
    normalize_runtime_environment()

    if SOCKET_FILE.exists():
        if _daemon_responds():
            log.info("Daemon already running (socket is responsive)")
            return
        log.warning("Found stale daemon socket at %s; removing it", SOCKET_FILE)
        try:
            SOCKET_FILE.unlink()
        except OSError as exc:
            log.error("Could not remove stale socket %s: %s", SOCKET_FILE, exc)
            raise
    cmd = _vice_cmd() + ["start", "--no-open-ui"]
    log.info("Starting daemon: %s", " ".join(cmd))
    # Route the daemon's stdout/stderr to a file so import-time crashes (which
    # happen before the daemon's logging is initialised, leaving vice.log empty)
    # are still recoverable for the launch error dialog. Truncated each launch
    # so the file always reflects the most recent attempt.
    DAEMON_STDERR_LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    stderr_fd = open(DAEMON_STDERR_LOG_FILE, "w")
    try:
        subprocess.Popen(
            cmd,
            env=os.environ.copy(),
            stdout=stderr_fd,
            stderr=stderr_fd,
            start_new_session=True,   # detach from our process group
        )
    except Exception as exc:
        log.error("Failed to start daemon: %s", exc)
        raise
    finally:
        stderr_fd.close()  # parent's copy; child has its own dup'd fd


def _stop_daemon() -> None:
    """Ask the daemon to shut down via IPC."""
    if not SOCKET_FILE.exists():
        return
    try:
        async def _send():
            reader, writer = await asyncio.open_unix_connection(str(SOCKET_FILE))
            writer.write(b"stop\n")
            await writer.drain()
            writer.close()
        asyncio.run(_send())
    except Exception as exc:
        log.debug("Stop IPC error: %s", exc)


def _wait_for_daemon_exit(timeout: float = 10.0) -> bool:
    """Wait for the running daemon to fully exit. Returns True if it did.

    Cloudflared tunnel teardown can take several seconds, so we poll the
    PID file (cleaned up only after full shutdown) plus the IPC socket.
    Force-kills the process via SIGKILL if it doesn't exit by `timeout`.
    """
    deadline = time.monotonic() + timeout
    pid: int | None = None
    try:
        pid = int(PID_FILE.read_text().strip())
    except (OSError, ValueError):
        pid = None

    while time.monotonic() < deadline:
        # Daemon writes its PID at startup and unlinks PID_FILE + SOCKET_FILE on exit.
        if not PID_FILE.exists() and not SOCKET_FILE.exists():
            return True
        if pid is not None:
            try:
                os.kill(pid, 0)  # signal 0 = "is process alive?"
            except ProcessLookupError:
                # Process is gone; let any final socket cleanup happen, then succeed.
                time.sleep(0.05)
                return True
            except PermissionError:
                pass  # alive but we can't signal it
        time.sleep(0.1)

    if pid is not None:
        log.warning("Daemon (pid=%s) did not exit in %.1fs — sending SIGKILL", pid, timeout)
        try:
            os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError) as exc:
            log.warning("SIGKILL on pid=%s failed: %s", pid, exc)
        # Best-effort: give the kernel a moment, then clean lingering files.
        time.sleep(0.3)
    for path in (PID_FILE, SOCKET_FILE):
        path.unlink(missing_ok=True)
    return True


def _wait_for_server(url: str, timeout: float = 20.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urlopen(url, timeout=1) as resp:
                status = getattr(resp, "status", 200)
                if 200 <= status < 400:
                    return True
        except HTTPError as exc:
            if 200 <= exc.code < 400:
                return True
            log.debug("Server probe failed for %s with HTTP %s", url, exc.code)
            time.sleep(0.25)
        except URLError:
            time.sleep(0.25)
        except Exception:
            time.sleep(0.25)
    return False


def _status_is_ready(status: dict | None) -> bool:
    return bool(status and status.get("ready") is True)


def _wait_for_ready_server(default_url: str, timeout: float = 20.0) -> str | None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status = _daemon_status(timeout=0.5)
        url = _server_url_from_status(status, default_url)
        if _status_is_ready(status) and _wait_for_server(url, timeout=1.0):
            return url
        time.sleep(0.25)
    return None


def _server_url_from_status(status: dict | None, fallback_url: str) -> str:
    raw = (status or {}).get("local_url")
    if not raw or not isinstance(raw, str):
        return fallback_url
    return raw.rstrip("/") + "/"


def _tail_text_file(path: Path, lines: int = 20) -> str:
    try:
        content = path.read_text(errors="replace").splitlines()
    except Exception:
        return ""
    if not content:
        return ""
    return "\n".join(content[-lines:])


def _startup_failure_detail(url: str) -> str:
    status = _daemon_status(timeout=0.5)
    lines: list[str] = []

    if status is None:
        lines.append("Daemon IPC socket did not become ready.")
    else:
        server_url = _server_url_from_status(status, url)
        lines.append(f"Daemon IPC responded but HTTP UI is unavailable at {server_url}")

    daemon_tail = _tail_text_file(DAEMON_LOG_FILE, lines=20)
    if daemon_tail:
        lines.append(f"Recent daemon log:\n{daemon_tail}")
    else:
        lines.append(f"No daemon log output was found at {DAEMON_LOG_FILE}")

    # vice.log is only populated after the daemon's logging.basicConfig runs.
    # If the daemon crashed during Python import (missing module, syntax error,
    # etc.) the formatted log will be empty — fall back to raw stderr so the
    # dialog still surfaces the actual traceback.
    if not daemon_tail:
        try:
            stderr_text = DAEMON_STDERR_LOG_FILE.read_text(errors="replace").strip()
            if stderr_text:
                tail = "\n".join(stderr_text.splitlines()[-40:])
                lines.append(f"Daemon stderr (pre-logging crash):\n{tail}")
        except FileNotFoundError:
            pass

    return "\n\n".join(lines)


def _clear_stale_socket() -> None:
    if not SOCKET_FILE.exists():
        return
    if _daemon_responds():
        return
    log.warning("Removing stale daemon socket at %s", SOCKET_FILE)
    SOCKET_FILE.unlink(missing_ok=True)


def _ensure_server(default_url: str, startup_timeout: float = 20.0) -> str | None:
    status = _daemon_status()
    if status is not None:
        url = _server_url_from_status(status, default_url)
        if _wait_for_server(url, timeout=2.0):
            # Self-heal package upgrades: a daemon launched before the upgrade
            # has stale Python code in memory (Python can't hot-reload), so
            # serving the new HTML through the old route table breaks the UI.
            daemon_version = (status or {}).get("version")
            if daemon_version and daemon_version != __version__:
                log.warning(
                    "Running daemon is v%s but this launcher is v%s — restarting daemon to pick up upgraded code",
                    daemon_version, __version__,
                )
                _stop_daemon()
                _wait_for_daemon_exit(timeout=10.0)
                _clear_stale_socket()
                # Fall through to _start_daemon() below.
            else:
                ready_url = _wait_for_ready_server(url, timeout=startup_timeout)
                if ready_url:
                    log.info("Daemon already running (IPC + HTTP healthy)")
                    return ready_url
                log.warning("Daemon HTTP responded but recorder did not become ready; restarting daemon")
                _stop_daemon()
                _wait_for_daemon_exit(timeout=10.0)
                _clear_stale_socket()
        else:
            log.warning("Daemon IPC responded but UI server did not (%s); restarting daemon", url)
            _stop_daemon()
            _wait_for_daemon_exit(timeout=10.0)
            _clear_stale_socket()
    else:
        _clear_stale_socket()

    _start_daemon()

    ready_url = _wait_for_ready_server(default_url, timeout=startup_timeout)
    if ready_url:
        return ready_url

    status = _daemon_status()
    url = _server_url_from_status(status, default_url)
    if url != default_url:
        ready_url = _wait_for_ready_server(url, timeout=2.0)
        if ready_url:
            return ready_url

    if status is not None:
        log.error("Daemon IPC is alive but HTTP UI is unavailable at %s", url)
    return None


# ── entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    global DEBUG_MODE
    debug = "--debug" in sys.argv[1:]
    DEBUG_MODE = debug

    normalize_runtime_environment()
    _setup_logging(debug=debug)
    signal.signal(signal.SIGTERM, _handle_app_terminate)
    signal.signal(signal.SIGINT, _handle_app_terminate)
    log.info("vice-app starting (python=%s, debug=%s)", sys.executable, debug)

    try:
        from .config import load as load_config
        cfg  = load_config()
        port = cfg.sharing.port
    except Exception as exc:
        log.error("Failed to load config: %s", exc)
        port = 8765

    url = f"http://127.0.0.1:{port}/"

    try:
        server_url = _ensure_server(url)
    except Exception:
        # Error already logged; show a user-visible message and exit.
        detail = _startup_failure_detail(url)
        log.error("Startup diagnostics:\n%s", detail)
        _show_error(
            "Vice could not start the recording daemon.\n\n"
            f"{detail}\n\n"
            f"Check the log for details:\n{LOG_FILE}"
        )
        sys.exit(1)

    log.info("Waiting for server at %s", url)
    if not server_url:
        log.error("Server did not start within 20 s")
        detail = _startup_failure_detail(url)
        log.error("Startup diagnostics:\n%s", detail)
        _show_error(
            "Vice started but the UI server did not respond.\n\n"
            f"{detail}\n\n"
            f"Check the log for details:\n{LOG_FILE}"
        )
        sys.exit(1)

    log.info("Server ready at %s, opening window", server_url)
    try:
        import webview  # type: ignore[import]
        _run_webview(server_url)
        log.info("Window closed")
    except ImportError:
        log.warning("pywebview not installed — falling back to browser")
        subprocess.Popen(
            ["xdg-open", server_url],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception as exc:
        log.error("pywebview crashed: %s", exc, exc_info=True)
        # Fall back to browser so the user isn't left with nothing
        log.warning("Falling back to browser")
        subprocess.Popen(
            ["xdg-open", server_url],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )


def _show_error(message: str) -> None:
    """Show a visible error — GTK dialog if possible, otherwise print."""
    log.error("UI error: %s", message)
    try:
        import gi
        gi.require_version("Gtk", "3.0")
        from gi.repository import Gtk
        diag = Gtk.MessageDialog(
            message_type=Gtk.MessageType.ERROR,
            buttons=Gtk.ButtonsType.OK,
            text="Vice — Error",
            secondary_text=message,
        )
        diag.run()
        diag.destroy()
    except Exception:
        print(f"[vice-app] ERROR: {message}", file=sys.stderr)


# ── pywebview window ──────────────────────────────────────────────────────────

def _is_nvidia() -> bool:
    return Path("/proc/driver/nvidia/version").exists()


def _prepare_webview_environment() -> None:
    """Set environment for a stable QtWebEngine (Chromium) session.

    Must run before QtWebEngine initialises — Chromium reads
    QTWEBENGINE_CHROMIUM_FLAGS once at startup.

    Why each flag is needed:
      • --disable-accelerated-video-decode / --disable-gpu-memory-buffer-
        video-frames: Chromium's hardware video decode is broken on many
        Linux GPU/driver combos and renders <video> as a black or grey
        rectangle while the rest of the UI works. Clips are short, local
        files; software decode is cheap and always correct.
      • --autoplay-policy: clip previews start without a click.
      • --disable-features=Vulkan + --disable-gpu-compositing (NVIDIA
        only): when Chromium rejects GBM it falls back to Vulkan
        rendering, which segfaults on some driver series (#82). Blocking
        Vulkan alone leaves no compositing path at all (a black window
        with "dma_buf acquisition failure" spam), so software compositing
        is forced alongside it. GBM health cannot be probed up front
        (driver 595 ships GBM backends and modeset=1 yet Chromium still
        rejects it), and the window is a clip gallery, so the uniform
        software-compositing cost on NVIDIA is negligible.

    Users can replace all of this by setting QTWEBENGINE_CHROMIUM_FLAGS
    themselves, or append extra flags via VICE_WEBVIEW_FLAGS.
    """
    # Qt requires a UTF-8 locale; a "C"/POSIX locale makes it switch with
    # loud warnings and has preceded renderer crashes (systemd services
    # often start with no locale at all).
    locale_value = os.environ.get("LC_ALL") or os.environ.get("LANG") or ""
    if locale_value in ("", "C", "POSIX"):
        os.environ["LC_ALL"] = "C.UTF-8"
        os.environ["LANG"] = "C.UTF-8"

    if "QTWEBENGINE_CHROMIUM_FLAGS" in os.environ:
        return  # user override — leave it alone
    flags = [
        "--disable-accelerated-video-decode",
        "--disable-gpu-memory-buffer-video-frames",
        "--autoplay-policy=no-user-gesture-required",
    ]
    if _is_nvidia():
        flags += ["--disable-features=Vulkan", "--disable-gpu-compositing"]
    extra = os.environ.get("VICE_WEBVIEW_FLAGS", "").strip()
    if extra:
        flags.append(extra)
    os.environ["QTWEBENGINE_CHROMIUM_FLAGS"] = " ".join(flags)
    log.info("QTWEBENGINE_CHROMIUM_FLAGS=%s", os.environ["QTWEBENGINE_CHROMIUM_FLAGS"])


def _patch_pywebview_qt_permissions() -> None:
    """Work around pywebview 6.x + PyQt6 6.11 enum-vs-int incompatibility.

    pywebview's Qt backend (`webview/platforms/qt.py:304`) calls
    `self.setFeaturePermission(url, feature, 2)` with a raw int for the
    permission policy. PyQt5 accepted ints; PyQt6 6.11 raises TypeError
    and the process SIGABRTs the first time any permission-gated API
    (clipboard, notifications, media-devices probe) is touched. Coerce
    the int to the proper enum so pywebview's callback works.
    """
    try:
        from PyQt6.QtWebEngineCore import QWebEnginePage
    except ImportError:
        return
    orig = QWebEnginePage.setFeaturePermission
    if getattr(orig, "_vice_patched", False):
        return

    def _patched(self, origin, feature, policy):
        if isinstance(policy, int):
            policy = QWebEnginePage.PermissionPolicy(policy)
        if isinstance(feature, int):
            feature = QWebEnginePage.Feature(feature)
        return orig(self, origin, feature, policy)

    _patched._vice_patched = True  # type: ignore[attr-defined]
    QWebEnginePage.setFeaturePermission = _patched


def _run_webview(url: str) -> None:
    _prepare_webview_environment()
    import webview  # type: ignore[import]

    class _API:
        """Methods exposed to JavaScript as window.pywebview.api.*"""

        def __init__(self) -> None:
            self._win: webview.Window | None = None

        def _bind(self, win: "webview.Window") -> None:
            self._win = win

        def quit_app(self) -> None:
            """Stop the daemon and close the window."""
            _stop_daemon()
            if self._win:
                self._win.destroy()

        def keep_running(self) -> None:
            """Close the window but keep the daemon recording."""
            if self._win:
                self._win.destroy()

        def open_url(self, url: str) -> None:
            """Open a URL in the system's default browser via xdg-open."""
            import subprocess as _sp
            try:
                _sp.Popen(
                    ["xdg-open", url],
                    stdout=_sp.DEVNULL,
                    stderr=_sp.DEVNULL,
                )
            except Exception:
                pass

        def log_debug(self, msg: str) -> None:
            """Forward a debug message from JS into the Python log."""
            try:
                log.debug("js: %s", str(msg)[:500])
            except Exception:
                pass

        def copy_to_clipboard(self, text: str) -> bool:
            """Copy `text` to the system clipboard via wl-copy / xclip / xsel.

            Invoked from JS as window.pywebview.api.copy_to_clipboard(text).
            QtWebEngine's in-page Clipboard API is unreliable (and has been
            seen to crash the render process) on http:// origins, so we bypass
            it here. Every attempt is logged at DEBUG level; enable --debug
            to capture the trace in ~/.local/share/vice/vice-debug.log.
            """
            import subprocess as _sp
            payload = (text or "").encode("utf-8")
            preview = (text or "")[:80].replace("\n", "\\n")
            log.debug("copy_to_clipboard: len=%d preview=%r", len(text or ""), preview)
            attempts = (["wl-copy"],
                        ["xclip", "-selection", "clipboard"],
                        ["xsel", "--clipboard", "--input"])
            for cmd in attempts:
                p = None
                try:
                    p = _sp.Popen(cmd, stdin=_sp.PIPE,
                                  stdout=_sp.DEVNULL, stderr=_sp.PIPE)
                    _, stderr = p.communicate(input=payload, timeout=2.0)
                    log.debug("copy_to_clipboard: %s rc=%s stderr=%r",
                              cmd[0], p.returncode,
                              (stderr or b"").decode(errors="replace")[:200])
                    if p.returncode == 0:
                        return True
                except FileNotFoundError:
                    log.debug("copy_to_clipboard: %s not installed", cmd[0])
                except _sp.TimeoutExpired:
                    log.warning("copy_to_clipboard: %s hung — killing", cmd[0])
                    if p is not None:
                        try: p.kill()
                        except Exception: pass
                except Exception as exc:
                    log.warning("copy_to_clipboard: %s raised %s", cmd[0], exc)
            log.warning("copy_to_clipboard: no backend succeeded")
            return False

    api = _API()

    # Pass ?native=1 so the JS can show the Quit/Minimize pill immediately —
    # pywebview's own window.pywebview is only injected after DOMContentLoaded,
    # which is too late for the initial render.
    sep = "&" if "?" in url else "?"
    native_url = f"{url}{sep}native=1"
    win = webview.create_window(
        title=WINDOW_TITLE,
        url=native_url,
        js_api=api,
        width=1280,
        height=820,
        min_size=(900, 600),
        background_color="#080b12",
        text_select=False,
        zoomable=False,
    )
    api._bind(win)

    # Pick the fastest available pywebview backend. QtWebEngine (Chromium) is
    # GPU-accelerated and sidesteps WebKit2GTK's software-compositing issues
    # on NVIDIA + Wayland entirely. GTK/WebKit2GTK is the fallback.
    # pywebview's Qt backend imports `qtpy` (a Qt-binding shim) plus the
    # PyQt6 QtWebEngine bindings — both must be present.
    def _enable_gtk_workarounds() -> None:
        # WebKit2GTK + Wayland + NVIDIA crashes with "Error 71 (Protocol error)".
        # XWayland is the safe path. These vars are harmless on other setups.
        os.environ.setdefault("WEBKIT_DISABLE_SANDBOX", "1")
        os.environ.setdefault("WEBKIT_DISABLE_DMABUF_RENDERER", "1")
        os.environ.setdefault("GDK_BACKEND", "x11")

    try:
        import PyQt6.QtWebEngineWidgets  # noqa: F401 — probe
        import qtpy                      # noqa: F401 — pywebview's Qt shim
        os.environ.setdefault("QT_API", "pyqt6")  # pin qtpy to PyQt6
        _patch_pywebview_qt_permissions()
        gui = "qt"
        log.info("Using QtWebEngine (Chromium) backend")
    except ImportError as exc:
        gui = None  # pywebview's Linux default: GTK/WebKit2GTK
        _enable_gtk_workarounds()
        log.info(
            "Qt backend unavailable (%s) — falling back to GTK WebKit on XWayland. "
            "For full GPU acceleration install python-pyqt6-webengine + python-qtpy.",
            exc,
        )

    try:
        webview.start(gui=gui, debug=False, private_mode=False)
    except Exception:
        log.exception("webview.start raised — backend=%s", gui)
        if gui != "qt":
            raise
        # Qt died before opening a window — retry once on GTK/WebKit2GTK
        # so the user still gets a native window instead of nothing.
        log.warning("Retrying with the GTK WebKit backend")
        _enable_gtk_workarounds()
        webview.start(gui=None, debug=False, private_mode=False)
    log.info("Window closed")


if __name__ == "__main__":
    main()
