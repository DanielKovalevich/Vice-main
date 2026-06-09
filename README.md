<p align="center">
  <img src="assets/vice.svg" width="96" alt="Vice icon"/>
</p>

<h1 align="center">Vice</h1>

<p align="center">
  <b>Instant-replay game clipping for Linux.</b><br/>
  Press one key to save the last 15 seconds of gameplay. No scenes, no setup, no upload.
</p>

<p align="center">
  <a href="https://viceclipper.framer.website/">Website</a> ·
  <a href="#install">Install</a> ·
  <a href="#features">Features</a> ·
  <a href="#configuration">Config</a> ·
  <a href="#troubleshooting">Troubleshooting</a>
</p>

---

## Install

**Arch / Manjaro / CachyOS / any Arch-based distro:**

```bash
yay -S vice-clipper     # or: paru -S vice-clipper
```

**Ubuntu / Debian / Mint / Fedora / openSUSE / other:**

```bash
git clone https://github.com/eklonofficial/Vice && cd Vice && ./install.sh
```

That's it. Launch **Vice** from your app menu (or run `vice-app`) and press **F9** in a game. If the terminal says `vice: command not found`, restart the terminal first.

Both paths install everything Vice needs, including the `gpu-screen-recorder` capture backend and a systemd user service so clipping starts at login. The script detects your package manager (`apt`, `dnf`, `pacman`, `zypper`) automatically.

| | Update | Uninstall |
|---|---|---|
| AUR | `yay -Syu` | `sudo pacman -Rns vice-clipper` |
| Git clone | `cd Vice && git pull && ./install.sh` | `vice uninstall && rm -rf Vice` |

> Don't mix the AUR package and `./install.sh` on the same machine. Uninstall one before switching.

**Bazzite / Fedora Atomic:** not supported yet. rpm-ostree systems can't use `install.sh`, and the installer exits early on them rather than breaking your system. A Flatpak will fix this; follow [#97](https://github.com/eklonofficial/Vice/issues/97).

---

## Features

- **Vice Clips.** A rolling buffer (2 minutes by default) always running in the background. Press **F9** to save the last 15 seconds.
- **Vice Sessions.** Double-tap **F9** to record a full match end to end. Single-tap during the session to drop color-coded highlight markers; the finished recording opens with all of them on the timeline.
- **Public share links.** Every clip gets a Cloudflare Tunnel URL. Paste it into Discord and the video plays inline as an embed, tinted with your theme color.
- **Game-tagged filenames.** Clips save as `Vice_Clip_4_Overwatch-2.mp4` when a known game is focused, using a curated game list. Nothing is guessed from window titles.
- **Separate audio tracks.** Keep game, voice chat, and microphone on their own tracks for editing (Settings → Recording → Separate audio tracks).
- **Medal-style gallery.** Hover previews, in-place rename, delete, share, and visual trim with lossless cut bounds.
- **Discord Rich Presence.** On by default for known games; turn it off in Settings anytime. Shows "Clipping &lt;Game&gt; with Vice" while a recognized game is focused. Add your own games via Settings → Discord.
- **Driver-level capture.** `gpu-screen-recorder` talks to NVENC/VAAPI directly, like ShadowPlay. Typical CPU usage under 1%.
- **Global hotkeys on every compositor.** Vice reads `/dev/input` via evdev, so the clip key works on Hyprland, GNOME, KDE, sway, and X11 with no per-WM keybind config. Keyboards can unplug and replug freely; Vice reattaches by itself.

## Using Vice

| Key / Action | What happens |
|---|---|
| **F9** | Save the last 15 s |
| **Extra clip keys** | Save their own duration, e.g. F6 for 60 s (Settings → Hotkeys) |
| **F9 · F9** (double-tap) | Start / stop a session recording |
| **F9** during a session | Drop a highlight at this moment |
| **Click a thumbnail** | Open viewer · ← → next/prev · **H** new highlight · **Esc** close |
| **Share** | Copy the public URL (pastes into Discord as a playable embed) |
| **Trim** | Drag handles to crop a clip in place |

Clips live in `~/Videos/Vice/`. Closing the window keeps the daemon recording; reopen from your launcher any time.

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

## Compatibility

| Compositor / Shell | | GPU | |
|---|---|---|---|
| Hyprland (Wayland) | ✅ | NVIDIA | ✅ NVENC |
| GNOME (Wayland) | ✅ | AMD / Intel | ✅ VAAPI |
| KDE Plasma (Wayland) | ✅ | Anything else | ✅ libx264 software fallback |
| sway (Wayland) | ✅ | | |
| Any X11 WM | ✅ | | |

`gpu-screen-recorder` is the default backend everywhere. `wf-recorder` (Wayland) and `ffmpeg x11grab` (X11) exist as explicit opt-ins via `recording.backend` for unusual setups; they are never auto-selected.

Game detection (filename tagging and Discord presence) works on X11, Hyprland, and sway. On other compositors clips simply save untagged.

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

The systemd user service created by the installer runs `vice start --no-open-ui`, so Vice clips at login without opening a window. Custom systemd/Nix units can use the same command.

## Configuration

Vice writes `~/.config/vice/config.toml` on first run. Everything below is also editable live from the GUI.

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

Notes:

- `recording.audio_tracks` records each listed source as its own audio track, in order. Browsers and Discord play only track 1; video editors see all of them. `container` and `audio_tracks` apply to the gpu-screen-recorder backend; wf-recorder/ffmpeg clips stay single-track MP4.
- `recording.gsr_args` supports environment/tilde expansion and a `{default_sink_monitor}` placeholder for desktop-audio capture.

## Troubleshooting

**`vice: command not found` after install.** Restart your terminal, or run `exec $SHELL` (fish: `exec fish`).

**App launcher icon does nothing.** Check `~/.local/share/vice/vice-app.log`. Most common cause: `gpu-screen-recorder` is missing from PATH. If the log mentions `autoaudiosink not found`, install your distro's GStreamer base/good plugin packages.

**Hotkey not firing.** Add yourself to the `input` group:
```bash
sudo usermod -aG input $USER && newgrp input
```

**Hotkey stopped after unplugging the keyboard.** Fixed in v1.2.0; Vice reattaches within a few seconds of replugging. Update if you're on an older version.

**Daemon can't find the Wayland session when started by systemd or the app launcher.** On Hyprland/Sway, the systemd user instance often doesn't inherit `WAYLAND_DISPLAY` from the compositor. Add to your compositor config:

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

**Share link only works on my local network.** Enable the tunnel in Settings → Sharing and make sure `cloudflared` is installed. cloudflared is the only supported tunnel; if it's missing, Vice shows an error in the UI instead of generating a broken link.

**Clip won't embed on Discord.** Discord only inlines videos up to about 50 MB; trim the clip or lower CRF/resolution. Links also stop working when the Vice daemon restarts, since a fresh tunnel URL is generated each run; repost the link after a restart. MKV clips don't embed; use the default MP4 container for sharing.

**UI looks like plain unstyled HTML right after an upgrade.** The previous daemon is still running old code in memory. Run `vice stop && vice-app` once. `vice-app` self-heals from the next upgrade onward.

**Native window is laggy.** Vice prefers QtWebEngine (Chromium, GPU-accelerated) and only falls back to WebKit2GTK if the Qt bindings are missing. Install them: `sudo pacman -S python-pyqt6-webengine` (Arch), `sudo apt install python3-pyqt6.qtwebengine` (Debian/Ubuntu), `sudo dnf install python3-pyqt6-webengine` (Fedora). Then run `vice-app`; the log should say `Using QtWebEngine (Chromium) backend`.

**Native window crashes when I click a button.** Reproduce it in debug mode:
```bash
vice stop
vice-app --debug
# reproduce the crash, then Ctrl+C if the window didn't exit
```
The log lands at `~/.local/share/vice/vice-debug.log`; attach it to a GitHub issue. Don't pipe the command through `tee`: Chromium's stderr can back up through the pipe and freeze the Qt event loop.

**Anything else.** Run `vice doctor` for full diagnostics, or open an issue with the output.

---

## Star History

[![Star History Chart](https://api.star-history.com/chart?repos=eklonofficial/Vice&type=date&legend=top-left)](https://www.star-history.com/?repos=eklonofficial%2FVice&type=date&legend=top-left)

## Credits

Created by **Andrew Marin** ([github.com/eklonofficial](https://github.com/eklonofficial)). Bug reports and PRs welcome.

## License

[GPL-3.0](LICENSE)
