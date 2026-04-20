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

## Highlights

- **One-key clips.** Rolling 2-minute buffer, **F9** saves the last 15 s. No OBS, no scene setup — a silent daemon runs in the background.
- **Session mode.** Double-tap the clip key to record a full scrim. Tap it again mid-session to drop a highlight marker — they show up on the viewer timeline when you stop.
- **Near-zero overhead.** Default backend is `gpu-screen-recorder`, which talks to NVENC/VAAPI at the driver level like ShadowPlay. Typical CPU usage: under 1 %.
- **Framer-inspired clip gallery.** Dark UI with hover-preview video on cards, in-place visual trim, colour-coded highlights, rename, delete, share.
- **Share links that embed in Discord.** Every clip gets a public Cloudflare Tunnel URL — paste into Discord and it plays inline, no upload.
- **Works everywhere on Linux.** Hyprland · GNOME · KDE · sway · X11. NVIDIA · AMD · Intel. bash · zsh · fish.

## Why Vice?

OBS has a replay buffer. So why use Vice?

|  | OBS Replay Buffer | Vice |
|---|---|---|
| **Setup time** | Launch OBS, build a scene, enable the buffer, bind a hotkey | Install, press F9 |
| **Always on** | OBS must stay open with a scene active | Silent daemon, always watching |
| **GPU overhead** | Encodes a composed scene continuously | Captures the compositor framebuffer directly — near zero |
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
| **F9 · F9** (double-tap) | Start / stop session recording |
| **F9** during a session | Drop a highlight at this moment |
| **Click a thumbnail** | Open viewer · ← → next/prev · **H** new highlight · **Esc** close |
| **Share** | Copy public URL (pastes into Discord as a playable embed) |
| **Trim** | Visually trim a clip in place |
| **Settings → Hotkeys** | Rebind the clip key — press any key, done |

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

---

## Configuration

Vice writes `~/.config/vice/config.toml` on first run. Everything below is editable live from the GUI.

```toml
[recording]
buffer_duration = 120     # seconds kept in the rolling buffer
clip_duration   = 15      # seconds saved per clip
fps             = 60
display         = "DP-1"  # optional; omit to auto-select the current display
encoder         = "auto"  # auto | h264_nvenc | hevc_nvenc | h264_vaapi | libx264 | libx265
backend         = "auto"  # auto | gsr | wf-recorder | ffmpeg
capture_audio   = true
capture_microphone = false
gsr_args        = ""      # extra gpu-screen-recorder flags, e.g. "-k hevc -bm cbr -q 20000"

[hotkeys]
clip = "KEY_F9"

[output]
directory = "~/Videos/Vice"

[sharing]
enabled           = true
port              = 8765  # local control UI (always 127.0.0.1)
public_port       = 8766  # public share-only server (defaults to port + 1)
cloudflare_tunnel = true
base_url          = ""    # optional public origin override (reverse proxy / custom domain)
```

`recording.gsr_args` supports environment/tilde expansion and a `{default_sink_monitor}` placeholder for desktop-audio capture.

---

## Troubleshooting

**`vice: command not found` after install** → restart your terminal, or run `exec $SHELL` (fish: `exec fish`).

**App launcher icon does nothing** → check `~/.local/share/vice/vice-app.log`. Most common cause: no capture backend present — install `gpu-screen-recorder`, `wf-recorder`, or `ffmpeg`. If the log mentions `autoaudiosink not found`, install your distro's GStreamer base/good plugin packages.

**Hotkey not firing** → add yourself to the `input` group:
```bash
sudo usermod -aG input $USER && newgrp input
```

**Share link only works on my local network** → enable the tunnel in Settings → Sharing, and make sure `cloudflared` is installed.

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
