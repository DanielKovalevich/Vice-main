<p align="center">
  <img src="assets/vice.svg" width="96" alt="Vice icon"/>
</p>

<h1 align="center">Vice</h1>

<p align="center">
  <b>Instant-replay game clipping for Linux.</b><br/>
  Press one key to save the last 15 seconds of gameplay in <code>~/Videos/Vice</code>.
</p>

<p align="center">
  <a href="https://viceclipper.framer.website/">Website</a> ·
  <a href="#install">Install</a> ·
  <a href="#why-vice">Why Vice</a> ·
  <a href="#configuration">Config</a>
</p>

---
## Star History

[![Star History Chart](https://api.star-history.com/chart?repos=eklonofficial/Vice&type=date&legend=top-left)](https://www.star-history.com/?repos=eklonofficial%2FVice&type=date&legend=top-left)

## Features

- **Vice Clips.** A rolling 2-minute buffer always running in the background. Press **F9** to save the last 15 seconds. No setup, no scenes, no upload.
- **Vice Sessions.** Double-tap **F9** to record a full match end to end. Double-tap again to stop, and the recording opens in the viewer with every highlight you marked already on the timeline.
- **Highlights.** Single-tap **F9** during a Vice Session to drop a colour-coded marker. Use them as scrub points later, or as anchors when you trim the best moments out.
- **Visual Trim.** Drag handles on the playhead to crop a clip in place. Lossless cut bounds, so quality stays pristine.
- **Public Share Links.** Every clip gets a Cloudflare Tunnel URL. Paste into Discord (or any chat) and the video plays inline as an embed. No upload step.
- **Discord Rich Presence.** On by default for known games; turn it off in Settings anytime. While Vice is recording and a known game is in focus, your Discord profile shows **"Clipping &lt;Game&gt; with Vice"** with an elapsed timer. About 100 popular games ship in the bundled list; add your own via Settings → Discord.
- **Medal-style gallery.** Hover-preview video on every card, in-place rename, delete, share, and visual trim from the same dark UI.
- **Driver-level capture.** Default backend is `gpu-screen-recorder`, talking to NVENC/VAAPI at the driver level like ShadowPlay. Typical CPU usage under 1%.
- **Customisable, unlimited global hotkeys, every compositor.** Reads `/dev/input/` via evdev, so the clip key works on Hyprland, GNOME, KDE, sway, and X11 with no per-WM keybind config.

## Why Vice?

OBS has a replay buffer. So why use Vice?

|  | OBS Replay Buffer | Vice |
|---|---|---|
| **Setup time** | Launch OBS, build a scene, enable the buffer, bind a hotkey | Install, press F9 |
| **Always on** | OBS must stay open with a scene active | Silent daemon, always watching |
| **GPU overhead** | Encodes a composed scene continuously | Captures the compositor framebuffer directly. Near zero. |
| **Global hotkey** | OBS must be focused (or use a plugin) | Reads evdev; works on every compositor |
| **Sharing** | Manual upload | Built-in public URL, Discord auto-embed |
| **Clip management** | None | Gallery, viewer, trim, highlights, rename |

---

## Install

### Arch / Manjaro / Arch-based (recommended)

```bash
yay -S vice-clipper     # or: paru -S vice-clipper
```

The AUR package also installs `gpu-screen-recorder`, so a working capture backend is ready immediately.

### Ubuntu / Debian / Fedora / other

```bash
git clone https://github.com/eklonofficial/Vice && cd Vice && ./install.sh
```

The installer picks the right package manager (`apt`, `dnf`, …), installs deps, and verifies a working capture backend before finishing. **Restart your terminal**, then launch **Vice** from your app launcher (or run `vice-app`).

> ⚠ Don't mix AUR + `./install.sh` on the same user install. Uninstall one before switching.

### Bazzite / Fedora Atomic

Bazzite, Fedora Silverblue/Kinoite, and other `rpm-ostree` atomic desktops are not supported by `install.sh` yet. The installer intentionally exits early on those systems instead of trying to use `dnf` or package layering. A Flatpak or atomic-safe install path is the intended future fix.

**Updating**

| | |
|---|---|
| AUR | `yay -Syu` (or `paru -Syu`) |
| Git clone | `cd Vice && git pull && ./install.sh` |

---

## Using Vice

| Key / Action | What happens |
|---|---|
| **F9** | Save the last 15 s |
| **Configured extra clip keys** | Save their assigned duration, e.g. F6 for 60 s |
| **F9 · F9** (double-tap) | Start / stop session recording |
| **F9** during a session | Drop a highlight at this moment |
| **Click a thumbnail** | Open viewer · ← → next/prev · **H** new highlight · **Esc** close |
| **Share** | Copy public URL (pastes into Discord as a playable embed) |
| **Trim** | Visually trim a clip in place |
| **Settings → Hotkeys** | Rebind the clip key. Press any key, done. |

Clips live in `~/Videos/Vice/`. Closing the window keeps the daemon running; reopen from your launcher any time.

---

## Compatibility

| Compositor / Shell | | GPU | |
|---|---|---|---|
| Hyprland (Wayland) | ✅ | NVIDIA | ✅ NVENC |
| GNOME (Wayland) | ✅ | AMD / Intel | ✅ VAAPI |
| KDE Plasma (Wayland) | ✅ | Anything else | ✅ libx264 software fallback |
| sway (Wayland) | ✅ | | |
| Any X11 WM | ✅ | | |

Vice picks the best of three backends automatically:

| Backend | Wayland | X11 | NVIDIA | AMD/Intel |
|---|---|---|---|---|
| `gpu-screen-recorder` (default) | ✅ | ✅ | ✅ NVENC | ✅ VAAPI |
| `wf-recorder` (Wayland fallback) | ✅ | — | ✅ | ✅ |
| `ffmpeg x11grab` (X11 fallback) | — | ✅ | ✅ | ✅ |

Hotkeys come from `/dev/input/` via evdev, so they work on every compositor with no keybind config.

---

## CLI

```
vice start          Start the recording daemon
vice start --no-open-ui
                    Start the daemon without opening the browser UI
vice stop           Stop the daemon
vice clip           Save a clip right now
vice status         Show daemon status, backend, and share URL
vice ui             Open the web UI in your browser
vice clips          List saved clips
vice config         Print current config
vice open-config    Open config in $EDITOR
vice list-keys      Show valid hotkey names (KEY_F9, KEY_INSERT, …)
vice doctor         Run startup diagnostics
vice uninstall      Remove Vice cleanly
```

The optional systemd service created by `install.sh` uses `vice start --no-open-ui`, so Vice can start at login and keep clipping without opening a window. Custom systemd/Nix units can use the same command.

---

## Configuration

Vice writes `~/.config/vice/config.toml` on first run. Everything below is editable live from the GUI.

```toml
[recording]
buffer_duration = 120     # seconds kept in the rolling buffer
clip_duration   = 15      # seconds saved per clip
fps             = 60
display         = "DP-1"  # optional; omit to use the backend default display
encoder         = "auto"  # auto | h264_nvenc | hevc_nvenc | h264_vaapi | hevc_vaapi | libx264 | libx265
backend         = "auto"  # auto | gsr | wf-recorder | ffmpeg
container       = "mp4"   # mp4 | mkv (mkv is crash-safe; Discord embeds need mp4)
capture_audio   = true
capture_microphone = false
gsr_audio_source = "default_output" # default_output | device:name | app:name | app-inverse:name
audio_tracks    = []      # separate tracks instead of a mix, e.g. ["default_output", "default_input", "app:Discord"]
gsr_args        = ""      # extra gpu-screen-recorder flags, e.g. "-k hevc -bm cbr -q 20000"

[hotkeys]
clip = "KEY_F9"

[[hotkeys.clip_presets]]
key = "KEY_F6"
duration = 60

[[hotkeys.clip_presets]]
key = "KEY_F7"
duration = 120

[output]
directory = "~/Videos/Vice"
tag_clips_with_game = true  # Vice_Clip_4_Overwatch-2.mp4 when a known game is focused

[sharing]
enabled           = true
port              = 8765  # local control UI (always 127.0.0.1)
public_port       = 8766  # public share-only server (defaults to port + 1)
cloudflare_tunnel = true
base_url          = ""    # optional public origin override (reverse proxy / custom domain)

[discord]
enabled            = true   # shows Rich Presence when a known/custom game is focused
client_id_override = ""     # leave blank to use Vice's default Discord app
# Add custom games via Settings → Discord. Each line is "Display Name | match1, match2".
```

`recording.gsr_args` supports environment/tilde expansion and a `{default_sink_monitor}` placeholder for desktop-audio capture. `recording.gsr_audio_source` is used by the default gpu-screen-recorder backend.

`recording.audio_tracks` records each listed source as its own audio track (gpu-screen-recorder backend). Track order matches the list; browsers and Discord play only the first track, while video editors see all of them. Useful for keeping game, voice chat, and microphone separable, like `["default_output", "default_input", "app:Discord"]`. The `container` and `audio_tracks` options apply to the gpu-screen-recorder backend; wf-recorder/ffmpeg clips stay single-track MP4.

---

## Troubleshooting

**`vice: command not found` after install** → restart your terminal, or run `exec $SHELL` (fish: `exec fish`).

**App launcher icon does nothing** → check `~/.local/share/vice/vice-app.log`. Most common cause: `gpu-screen-recorder` is missing from PATH (install.sh installs it automatically; if you used the AUR package it's a hard dependency). If the log mentions `autoaudiosink not found`, install your distro's GStreamer base/good plugin packages.

**Hotkey not firing** → add yourself to the `input` group:
```bash
sudo usermod -aG input $USER && newgrp input
```

**Daemon fails to find Wayland session when started by systemd or app launcher** → on Hyprland/Sway, the systemd user instance often doesn't inherit `WAYLAND_DISPLAY` and friends from the compositor. Add to your compositor config:

Hyprland (`~/.config/hypr/hyprland.conf`):
```
exec-once = systemctl --user import-environment WAYLAND_DISPLAY DISPLAY DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR XDG_SESSION_TYPE XDG_CURRENT_DESKTOP
exec-once = dbus-update-activation-environment --systemd WAYLAND_DISPLAY DISPLAY DBUS_SESSION_BUS_ADDRESS XDG_CURRENT_DESKTOP
```

Sway (`~/.config/sway/config`):
```
exec systemctl --user import-environment WAYLAND_DISPLAY DISPLAY DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR XDG_SESSION_TYPE XDG_CURRENT_DESKTOP
exec dbus-update-activation-environment --systemd WAYLAND_DISPLAY DISPLAY DBUS_SESSION_BUS_ADDRESS XDG_CURRENT_DESKTOP
```

Restart your compositor session, then `systemctl --user restart vice.service`.

**Share link only works on my local network** → enable the tunnel in Settings → Sharing, and make sure `cloudflared` is installed.

**UI looks like plain unstyled HTML right after an upgrade** → the previous daemon is still running with the old Python code in memory. `vice stop && vice-app` once (or relaunch from your app menu). `vice-app` self-heals from the next upgrade onward.

**Native window is laggy** → Vice prefers QtWebEngine (Chromium, GPU-accelerated) and only falls back to WebKit2GTK if the Qt bindings are missing. Install them: `sudo pacman -S python-pyqt6-webengine` (Arch), `sudo apt install python3-pyqt6.qtwebengine` (Debian/Ubuntu), `sudo dnf install python3-pyqt6-webengine` (Fedora). Then run `vice-app`; the log should say `Using QtWebEngine (Chromium) backend`.

**Native window crashes when I click a button?** Reproduce it in debug mode so we can see exactly what happened:
```bash
vice stop
vice-app --debug
# reproduce the crash, then Ctrl+C if the window didn't exit
```
The log lands at `~/.local/share/vice/vice-debug.log`. Attach that to a GitHub issue. Don't pipe the command through `tee`: Chromium's stderr can back up through the pipe and freeze the Qt event loop. The debug log file already captures every JS and Python event.

**Anything else** → run `vice doctor` for full diagnostics, or open an issue with the output.

### Uninstall

| | |
|---|---|
| AUR | `sudo pacman -Rns vice-clipper` |
| Git clone | `vice uninstall && rm -rf Vice` |

---

## Credits

Created by **Andrew Marin** — [github.com/eklonofficial](https://github.com/eklonofficial). Bug reports and PRs welcome.

## License

[GPL-3.0](LICENSE)
