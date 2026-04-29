# Vice — GitHub Issues Export

**Repository:** Vice
**Total issues:** 13
**Order:** Chronological, oldest → newest (issue numbers do not follow this order)
**Generated:** April 28, 2026

---

## Table of Contents

1. [Issue #11 — Potential game highlights integration?](#issue-11--potential-game-highlights-integration) *(Open)*
2. [Issue #38 — Request: Add embed color(s)](#issue-38--request-add-embed-colors) *(Open)*
3. [Issue #41 — Vice fails to find a segment to clip from](#issue-41--vice-fails-to-find-a-segment-to-clip-from) *(Open)*
4. [Issue #45 — Exclude certain programs audio in settings + multi-track audio for individual programs.](#issue-45--exclude-certain-programs-audio-in-settings--multi-track-audio-for-individual-programs) *(Open)*
5. [Issue #47 — Discord rich presence?](#issue-47--discord-rich-presence) *(Open — was closed and reopened)*
6. [Issue #48 — I open Vice and I get an error message(screenshot below)](#issue-48--i-open-vice-and-i-get-an-error-messagescreenshot-below) *(Open — was closed and reopened)*
7. [Issue #49 — HEVC VAAPI Support](#issue-49--hevc-vaapi-support) *(Open)*
8. [Issue #50 — MKV file support](#issue-50--mkv-file-support) *(Open)*
9. [Issue #51 — Add support for AppImage](#issue-51--add-support-for-appimage) *(Open)*
10. [Issue #53 — Sound not being picked up in clips](#issue-53--sound-not-being-picked-up-in-clips) *(Open)*
11. [Issue #55 — cloudflare tunnel error 1033 when trying to publish](#issue-55--cloudflare-tunnel-error-1033-when-trying-to-publish) *(Open)*
12. [Issue #57 — Localhost refused to connect](#issue-57--localhost-refused-to-connect) *(Open)*
13. [Issue #58 — Having different hotkeys for different clip durations](#issue-58--having-different-hotkeys-for-different-clip-durations) *(Open)*

---

## Issue #11 — Potential game highlights integration?

**Status:** 🟢 Open
**Opened:** Mar 10, 2026 by **Internetbestfriend** *(edited by Internetbestfriend)*
**Labels:** `enhancement`
**Assignees:** None
**Milestone:** None
**Participants:** Internetbestfriend, eklonofficial (Owner), DeveloperSpoot

### Original Post

> **Internetbestfriend** — *Mar 10, 2026*
>
> I was thinking, that certain games expose game data either via the Steam Timeline feature, Game State Integration, Nvidia Highlights or other interfaces. These has been used by other recording gaming software or even various peripherals (such as Mouse and Keyboards, see game state), scripts etc.
>
> I was wondering if it would be possible to utilise this exposed data, to set recording conditions?
>
> E.g. After detecting 5 kills in a competitive CS match (an ace) and a round victory, Vice would automatically save that instant replay.

### Conversation Thread

**eklonofficial** (Owner) — *Mar 10, 2026*

> This is something that I'd definitely like to add down the line, especially if I see a lot of interest.
>
> *Reactions: 👍 1*

---

*🏷️ **eklonofficial** added the `enhancement` label on Mar 13, 2026*

---

**DeveloperSpoot** — *Mar 17, 2026*

> Adding on to this, it would be cool if the clips name included the game name.

---

## Issue #38 — Request: Add embed color(s)

**Status:** 🟢 Open
**Opened:** Mar 16, 2026 by **DeveloperSpoot**
**Labels:** `enhancement`
**Assignees:** None
**Milestone:** None
**Participants:** DeveloperSpoot, eklonofficial (Owner)
**Cross-references:** Mentioned in PR/Issue #39 (Theme color embeds)

### Original Post

> **DeveloperSpoot** — *Mar 16, 2026*
>
> Just as a flare, it would be nice to see embeds have a color instead of the current gray color. I was thinking updating the meta data to include whatever theme color is selected.

### Conversation Thread

*✏️ **DeveloperSpoot** changed the title from "Request: Add embed color(s0" to "Request: Add embed color(s)" on Mar 16, 2026*

---

*🏷️ **eklonofficial** added the `enhancement` label on Mar 17, 2026*

---

*🔗 **DeveloperSpoot** mentioned this issue on Mar 18, 2026 — linked to **Theme color embeds #39***

---

## Issue #41 — Vice fails to find a segment to clip from

**Status:** 🟢 Open
**Opened:** Mar 20, 2026 by **Gryphonnnn**
**Labels:** *(none shown)*
**Assignees:** None
**Milestone:** None
**Participants:** Gryphonnnn (Author), eklonofficial (Owner)

### Original Post

> **Gryphonnnn** — *Mar 20, 2026*
>
> Vice fails to find segments available to clip from when I press the, recording sessions supposedly work according to vice but they do not show in the vidoes/vice foler
>
> ```
> 18:27:09 [vice.recorder] INFO: Selected backend: wf-recorder (Wayland segment mode)
> 18:27:09 [vice.recorder] INFO: NVIDIA GPU detected → using h264_nvenc
> 18:27:09 [vice.share] INFO: Vice local control UI: http://127.0.0.1:8765
> 18:27:09 [vice.share] INFO: Vice public share server: http://192.168.1.180:8766
> 18:27:09 [vice.share] INFO: Vice legacy share compatibility URL: http://192.168.1.180:8765
> 18:27:09 [vice.share] INFO: Starting Cloudflare Tunnel on port 8766
> 18:27:09 [vice.hotkey] INFO: Listening for hotkeys on 3 device(s)
> 18:27:09 [vice.recorder] INFO: Starting segment recorder (backend=wf-recorder, encoder=h264_nvenc)
> 18:27:09 [vice] INFO: Vice local control UI: http://127.0.0.1:8765
> 18:27:09 [vice] INFO: Vice daemon ready (backend=wf-recorder, share_enabled=True)
> 18:27:09 [vice.share] INFO: Cloudflare Tunnel URL: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps
> 18:27:19 [vice.share] INFO: Cloudflare Tunnel URL: https://yrs-copyrighted-marc-mistress.trycloudflare.com
> 18:30:17 [vice.recorder] ERROR: No segments available to clip from
> 18:30:30 [vice.recorder] ERROR: No segments available to clip from
> 18:33:03 [vice.recorder] ERROR: No segments available to clip from
> 18:34:00 [vice.recorder] ERROR: No segments available to clip from
> 18:34:06 [vice.recorder] ERROR: No segments available to clip from
> 18:34:09 [vice.recorder] INFO: NVIDIA GPU detected → using h264_nvenc
> 18:34:09 [vice.recorder] INFO: Starting session recording: wf-recorder --force-yuv -f /home/Gryphonn_/Videos/Vice/Vice_Session_1.mp4 --audio=alsa_output.pci-0000_00_1f.3.analog-stereo.monitor -c h264_nvenc
> 18:34:17 [vice.recorder] WARNING: Session stop signal error:
> 18:34:17 [vice.recorder] ERROR: Session file not found after stop: /home/Gryphonn_/Videos/Vice/Vice_Session_1.mp4
> 18:34:50 [vice.recorder] ERROR: No segments available to clip from
> 18:35:05 [vice.recorder] INFO: NVIDIA GPU detected → using h264_nvenc
> 18:35:05 [vice.recorder] INFO: Starting session recording: wf-recorder --force-yuv -f /home/Gryphonn_/Videos/Vice/Vice_Session_1.mp4 --audio=alsa_output.pci-0000_00_1f.3.analog-stereo.monitor -c h264_nvenc
> 18:36:49 [vice.recorder] ERROR: No segments available to clip from
> 18:36:51 [vice.recorder] ERROR: No segments available to clip from
> ```
>
> also does not detect my second monitor, but I don't know if that is a bug or not

### Conversation Thread

**eklonofficial** (Owner) — *Mar 21, 2026*

> Quickest fix is probably to go to settings and change backend to gpu-screen-recorder, but to fix this:
>
> Can you give me the output of these commands:
>
> ```
> wf-recorder -L
>
> wf-recorder --force-yuv -f /home/Gryphonn_/Videos/Vice/vice_test.mp4 --audio=alsa_output.pci-0000_00_1f.3.analog-stereo.monitor -c h264_nvenc
> ```
>
> Let's these run for about 5-10 seconds, then press Ctrl+C, then run:
>
> ```
> ls -lh /home/Gryphonn_/Videos/Vice/vice_test.mp4
>
> wf-recorder --force-yuv -f /home/Gryphonn_/Videos/Vice/vice_test_libx264.mp4 --audio=alsa_output.pci-0000_00_1f.3.analog-stereo.monitor -c libx264
>
> wf-recorder --force-yuv -f /home/Gryphonn_/Videos/Vice/vice_test_noaudio.mp4 -c libx264
>
> pactl list short sources
>
> ls -lah /tmp/vice/segs
> ```

---

**Gryphonnnn** (Author) — *Mar 22, 2026*

> *(Note: in GitHub the user's typed commands are shown with strikethrough; the lines without strikethrough are terminal output. Both are preserved below as a single terminal session.)*
>
> ```
> Gryphonn_:$ wf-recorder -L
> wf-recorder: invalid option -- 'L'
> Unsupported command line argument (null)
> compositor doesn't support wlr-screencopy-unstable-v1
> Gryphonn_:$ wf-recorder --force-yuv -f /home/Gryphonn_/Videos/Vice/vice_test.mp4 --audio=alsa_output.pci-0000_00_1f.3.analog-stereo.monitor -c h264_nvenc
> wf-recorder: unrecognized option '--force-yuv'
> Unsupported command line argument (null)
> compositor doesn't support wlr-screencopy-unstable-v1
> Gryphonn_:$ ls -lh /home/Gryphonn_/Videos/Vice/vice_test.mp4
> ls: cannot access '/home/Gryphonn_/Videos/Vice/vice_test.mp4': No such file or directory
> Gryphonn_:$ wf-recorder --force-yuv -f /home/Gryphonn_/Videos/Vice/vice_test_libx264.mp4 --audio=alsa_output.pci-0000_00_1f.3.analog-stereo.monitor -c libx264
> wf-recorder: unrecognized option '--force-yuv'
> Unsupported command line argument (null)
> compositor doesn't support wlr-screencopy-unstable-v1
> Gryphonn_:$ wf-recorder --force-yuv -f /home/Gryphonn_/Videos/Vice/vice_test_noaudio.mp4 -c libx264
> wf-recorder: unrecognized option '--force-yuv'
> Unsupported command line argument (null)
> compositor doesn't support wlr-screencopy-unstable-v1
> Gryphonn_:$ pactl list short sources
> 59022   alsa_output.pci-0000_00_1f.3.analog-stereo.monitor   PipeWire   s32le 2ch 48000Hz   SUSPENDED
> 59023   alsa_output.usb-APDQM-0623-M_APDQM-0623-M_20230208-00.analog-stereo.monitor   PipeWire   s16le 2ch 48000Hz   SUSPENDED
> 59024   alsa_input.usb-APDQM-0623-M_APDQM-0623-M_20230208-00.analog-stereo   PipeWire   s16le 2ch 48000Hz   SUSPENDED
> Gryphonn_:$ ls -lah /tmp/vice/segs
> total 0
> drwxr-xr-x. 2 Gryphonn_ Gryphonn_  40 Mar 22 08:42 .
> drwxr-xr-x. 3 Gryphonn_ Gryphonn_ 100 Mar 22 08:43 ..
> Gryphonn_:$
> ```

---

**eklonofficial** (Owner) — *Mar 22, 2026*

> Update to 1.0.18. Let me know if it's fixed.

---

**Gryphonnnn** (Author) — *Mar 23, 2026*

> still getting an error
>
> *Attachment: vice-app.log*
>
> ```
> :27:09 [vice.recorder] INFO: Selected backend: wf-recorder (Wayland segment mode)
> 18:27:09 [vice.recorder] INFO: NVIDIA GPU detected → using h264_nvenc
> 18:27:09 [vice.share] INFO: Vice local control UI: http://127.0.0.1:8765
> 18:27:09 [vice.share] INFO: Vice public share server: http://192.168.1.180:8766
> 18:27:09 [vice.share] INFO: Vice legacy share compatibility URL: http://192.168.1.180:8765
> 18:27:09 [vice.share] INFO: Starting Cloudflare Tunnel on port 8766
> 18:27:09 [vice.hotkey] INFO: Listening for hotkeys on 3 device(s)
> 18:27:09 [vice.recorder] INFO: Starting segment recorder (backend=wf-recorder, encoder=h264_nvenc)
> 18:27:09 [vice] INFO: Vice local control UI: http://127.0.0.1:8765
> 18:27:09 [vice] INFO: Vice daemon ready (backend=wf-recorder, share_enabled=True)
> 18:27:09 [vice.share] INFO: Cloudflare Tunnel URL: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps
> 18:27:19 [vice.share] INFO: Cloudflare Tunnel URL: https://yrs-copyrighted-marc-mistress.trycloudflare.com
> 18:30:17 [vice.recorder] ERROR: No segments available to clip from
> 18:30:30 [vice.recorder] ERROR: No segments available to clip from
> 18:33:03 [vice.recorder] ERROR: No segments available to clip from
> 18:34:00 [vice.recorder] ERROR: No segments available to clip from
> 18:34:06 [vice.recorder] ERROR: No segments available to clip from
> 18:34:09 [vice.recorder] INFO: NVIDIA GPU detected → using h264_nvenc
> 18:34:09 [vice.recorder] INFO: Starting session recording: wf-recorder --force-yuv -f /home/Gryphonn_/Videos/Vice/Vice_Session_1.mp4 --audio=alsa_output.pci-0000_00_1f.3.analog-stereo.monitor -c h264_nvenc
> 18:34:17 [vice.recorder] WARNING: Session stop signal error:
> 18:34:17 [vice.recorder] ERROR: Session file not found after stop: /home/Gryphonn_/Videos/Vice/Vice_Session_1.mp4
> 18:34:50 [vice.recorder] ERROR: No segments available to clip from
> 18:35:05 [vice.recorder] INFO: NVIDIA GPU detected → using h264_nvenc
> 18:35:05 [vice.recorder] INFO: Starting session recording: wf-recorder --force-yuv -f /home/Gryphonn_/Videos/Vice/Vice_Session_1.mp4 --audio=alsa_output.pci-0000_00_1f.3.analog-stereo.monitor -c h264_nvenc
> 18:36:49 [vice.recorder] ERROR: No segments available to clip from
> 18:36:51 [vice.recorder] ERROR: No segments available to clip from
> 18:42:04 [vice.recorder] INFO: Selected backend: wf-recorder (Wayland segment mode)
> 18:42:04 [vice.recorder] INFO: NVIDIA GPU detected → using h264_nvenc
> 18:42:04 [vice.share] INFO: Vice local control UI: http://127.0.0.1:8765
> 18:42:04 [vice.share] INFO: Vice public share server: http://192.168.1.180:8766
> 18:42:04 [vice.share] INFO: Vice legacy share compatibility URL: http://192.168.1.180:8765
> 18:42:04 [vice.share] INFO: Starting Cloudflare Tunnel on port 8766
> 18:42:05 [vice.hotkey] INFO: Listening for hotkeys on 3 device(s)
> 18:42:05 [vice.recorder] INFO: Starting segment recorder (backend=wf-recorder, encoder=h264_nvenc)
> 18:42:05 [vice] INFO: Vice local control UI: http://127.0.0.1:8765
> 18:42:05 [vice] INFO: Vice daemon ready (backend=wf-recorder, share_enabled=True)
> 18:42:05 [vice.share] INFO: Cloudflare Tunnel URL: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps
> 18:42:08 [vice.share] INFO: Cloudflare Tunnel URL: https://transcript-ultimate-facility-certainly.trycloudflare.com
> 18:42:42 [vice.recorder] ERROR: No segments available to clip from
> 21:06:48 [vice.hotkey] WARNING: Device /dev/input/event5 disconnected: [Errno 19] No such device
> 21:39:17 [vice.recorder] ERROR: No segments available to clip from
> 21:39:19 [vice.recorder] ERROR: No segments available to clip from
> 21:39:56 [vice.recorder] ERROR: No segments available to clip from
> 21:40:36 [vice.recorder] INFO: Selected backend: wf-recorder (Wayland segment mode)
> 21:40:36 [vice.recorder] INFO: NVIDIA GPU detected → using h264_nvenc
> 21:40:36 [vice.share] INFO: Vice local control UI: http://127.0.0.1:8765
> 21:40:36 [vice.share] INFO: Vice public share server: http://192.168.1.180:8766
> 21:40:36 [vice.share] INFO: Vice legacy share compatibility URL: http://192.168.1.180:8765
> 21:40:36 [vice.share] INFO: Starting Cloudflare Tunnel on port 8766
> 21:40:36 [vice.hotkey] INFO: Listening for hotkeys on 3 device(s)
> 21:40:36 [vice.recorder] INFO: Starting segment recorder (backend=wf-recorder, encoder=h264_nvenc)
> 21:40:36 [vice] INFO: Vice local control UI: http://127.0.0.1:8765
> 21:40:36 [vice] INFO: Vice daemon ready (backend=wf-recorder, share_enabled=True)
> 21:40:36 [vice.share] INFO: Cloudflare Tunnel URL: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps
> 21:40:40 [vice.share] INFO: Cloudflare Tunnel URL: https://vehicle-devoted-beats-whether.trycloudflare.com
> 21:40:42 [vice.recorder] ERROR: No segments available to clip from
> 11:58:23 [vice.recorder] INFO: Selected backend: wf-recorder (Wayland segment mode)
> 11:58:24 [vice.recorder] INFO: NVIDIA GPU detected → using h264_nvenc
> 11:58:24 [vice.share] INFO: Vice local control UI: http://127.0.0.1:8765
> 11:58:24 [vice.share] INFO: Vice public share server: http://192.168.1.180:8766
> 11:58:24 [vice.share] INFO: Vice legacy share compatibility URL: http://192.168.1.180:8765
> 11:58:24 [vice.share] INFO: Starting Cloudflare Tunnel on port 8766
> 11:58:24 [vice.hotkey] INFO: Listening for hotkeys on 3 device(s)
> 11:58:24 [vice.recorder] INFO: Starting segment recorder (backend=wf-recorder, encoder=h264_nvenc)
> 11:58:24 [vice] INFO: Vice local control UI: http://127.0.0.1:8765
> 11:58:24 [vice] INFO: Vice daemon ready (backend=wf-recorder, share_enabled=True)
> 11:58:24 [vice.share] INFO: Cloudflare Tunnel URL: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps
> 11:58:28 [vice.share] INFO: Cloudflare Tunnel URL: https://producer-buried-ordinary-cork.trycloudflare.com
> 11:58:31 [vice.recorder] ERROR: No segments available to clip from
> 11:58:32 [vice.recorder] ERROR: No segments available to clip from
> 12:00:40 [vice.recorder] ERROR: No segments available to clip from
> 08:42:59 [vice.recorder] INFO: Selected backend: wf-recorder (Wayland segment mode)
> 08:43:00 [vice.recorder] INFO: NVIDIA GPU detected → using h264_nvenc
> 08:43:00 [vice.share] INFO: Vice local control UI: http://127.0.0.1:8765
> 08:43:00 [vice.share] INFO: Vice public share server: http://192.168.1.180:8766
> 08:43:00 [vice.share] INFO: Vice legacy share compatibility URL: http://192.168.1.180:8765
> 08:43:00 [vice.share] INFO: Starting Cloudflare Tunnel on port 8766
> 08:43:00 [vice.hotkey] INFO: Listening for hotkeys on 3 device(s)
> 08:43:00 [vice.recorder] INFO: Starting segment recorder (backend=wf-recorder, encoder=h264_nvenc)
> 08:43:00 [vice] INFO: Vice local control UI: http://127.0.0.1:8765
> 08:43:00 [vice] INFO: Vice daemon ready (backend=wf-recorder, share_enabled=True)
> 08:43:00 [vice.share] INFO: Cloudflare Tunnel URL: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps
> 08:43:04 [vice.share] INFO: Cloudflare Tunnel URL: https://ipod-specific-rabbit-facing.trycloudflare.com
> 11:52:45 [vice.hotkey] WARNING: Device /dev/input/event5 disconnected: [Errno 19] No such device
> 18:47:31 [vice.recorder] INFO: Selected backend: wf-recorder (Wayland segment mode)
> 18:47:32 [vice.recorder] INFO: NVIDIA GPU detected → using h264_nvenc
> 18:47:32 [vice.share] INFO: Vice local control UI: http://127.0.0.1:8765
> 18:47:32 [vice.share] INFO: Vice public share server: http://192.168.1.180:8766
> 18:47:32 [vice.share] INFO: Vice legacy share compatibility URL: http://192.168.1.180:8765
> 18:47:32 [vice.share] INFO: Starting Cloudflare Tunnel on port 8766
> 18:47:32 [vice.hotkey] INFO: Listening for hotkeys on 3 device(s)
> 18:47:32 [vice.recorder] INFO: Starting segment recorder (backend=wf-recorder, encoder=h264_nvenc)
> 18:47:32 [vice] INFO: Vice local control UI: http://127.0.0.1:8765
> 18:47:32 [vice] INFO: Vice daemon ready (backend=wf-recorder, share_enabled=True)
> 18:47:32 [vice.share] INFO: Cloudflare Tunnel URL: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps
> ```
>
> and then 700 lines of
>
> ```
> 18:49:56 [vice.recorder] ERROR: Segment recorder did not produce output: compositor doesn't support wlr-screencopy-unstable-v1
> ```

---

**Gryphonnnn** (Author) — *Mar 23, 2026*

> wait it didn't update for some reason

---

**Gryphonnnn** (Author) — *Mar 23, 2026*

> hm uninstalled and updated again and it still says its on version 1.0.17
>
> *(Attached screenshot of "About" dialog showing: "Vice — game clip recorder for Linux / Vice / Medal.tv-style instant replay clips for Linux / Version 1.0.17 · GPL-3.0")*

---

**eklonofficial** (Owner) — *Mar 23, 2026*

> Don't worry it did update. When I originally made the version variable I made it a hardcoxed one I had to manually change each update (because I'm smart like that) and forgot to change it on the last one. I'll fix that along with this issue is the next update

---

**Gryphonnnn** (Author) — *Mar 24, 2026*

> still has an error after updating to 1.0.19, but idk if you fixed it

---

**eklonofficial** (Owner) — *Mar 24, 2026*

> Not yet still working on it, that was to fix something else

---

**eklonofficial** (Owner) — *Mar 25, 2026*

> Do you still have the error with 1.0.20? I fixed a separate issue that might be related, if not I'll look at this more specifically.

---

**Gryphonnnn** (Author) — *Mar 27, 2026*

> *(Attached screenshot of Vice window with tooltip "Window menu" and error text: "Could not connect to localhost: Connection refused")*
>
> well now I just get this

---

## Issue #45 — Exclude certain programs audio in settings + multi-track audio for individual programs.

**Status:** 🟢 Open
**Opened:** ~Apr 7, 2026 *(displayed as "3 weeks ago" — exact date approximate)* by **Biblioklept**
**Labels:** *(none)*
**Assignees:** None
**Milestone:** None
**Participants:** Biblioklept, Dontknow09, Warionator

### Original Post

> **Biblioklept** — *~Apr 7, 2026 ("3 weeks ago")*
>
> A feature to mute certain program's audio from being recorded and/or put different program's audio onto different tracks (i.e. Game audio track 1, Vesktop audio track 2, Microphone audio track 3, etc. and mute Firefox or at least move its audio to track 4.
>
> *Reactions: 👍 1*

### Conversation Thread

**Dontknow09** — *~Apr 7, 2026 ("3 weeks ago")*

> this would be great for someone like me that has spotify playing in the background and heavily relying on obs to separate it to a different track (although that barely works when you're in a discord call). would love to see such a thing added!
>
> *Reactions: 👍 1*

---

**Warionator** — *~Apr 25, 2026 ("3 days ago")*

> This would be really good. Sometimes I want to mute my mic in certain clips or adjust Discord volume. Medal.tv has an option to record only Discord, Mic, and Game, and have them all on separate tracks. This would be a really nice feature to have here

---

## Issue #47 — Discord rich presence?

**Status:** 🟢 Open *(was closed as completed, then reopened)*
**Opened:** ~Apr 7, 2026 *(displayed as "3 weeks ago" — exact date approximate)* by **Dontknow09**
**Labels:** `enhancement`
**Assignees:** None
**Milestone:** None
**Participants:** Dontknow09, eklonofficial (Owner)

### Original Post

> **Dontknow09** — *~Apr 7, 2026 ("3 weeks ago")*
>
> could something like what medal has be added to vice so friends can see what we're clipping? in other words, the apps sets the discord status to what we're doing. check the image and discord dev wiki for further explanation lol
>
> *(Attached screenshot of a Discord rich presence card showing: "Playing — Roblox with Medal — Clipping Roblox with Medal — 42:38 — Follow on Medal — Download Medal")*

### Conversation Thread

**eklonofficial** (Owner) — *~Apr 14, 2026 ("2 weeks ago")*

> Possibly, I'll look into this

---

*🏷️ **eklonofficial** added the `enhancement` label ~Apr 14, 2026 ("2 weeks ago")*

---

**eklonofficial** (Owner) — *~Apr 21, 2026 ("last week")*

> @Dontknow09 just added this in v1.1.2, go check it out!

---

*✅ **eklonofficial** closed this as **completed** ~Apr 21, 2026 ("last week")*

---

*🔄 **eklonofficial** reopened this ~Apr 21, 2026 ("last week")*

---

**eklonofficial** (Owner) — *~Apr 21, 2026 ("last week") — edited by eklonofficial*

> Just noticed this doesn't seem to work reliable sometimes. I'll see if this can be fixed.

---

## Issue #48 — I open Vice and I get an error message(screenshot below)

**Status:** 🟢 Open *(was closed as completed, then reopened)*
**Opened:** ~Apr 7, 2026 *(displayed as "3 weeks ago" — exact date approximate)* by **Kite433**
**Labels:** `bug` *(label history: `bug` + `in the works` added → both removed and `Coming next update` added → `Coming next update` removed and `bug` re-added)*
**Assignees:** None
**Milestone:** None
**Participants:** Kite433 (Author), Terence-1, yogoswaggins-boop, eklonofficial (Owner)

### Original Post

> **Kite433** — *~Apr 7, 2026 ("3 weeks ago")*
>
> *(Attached screenshot of an error dialog titled "Vice — Error" with the following text:)*
>
> > Vice started but the UI server did not respond.
> >
> > Daemon IPC socket did not become ready.
> >
> > No daemon log output was found at /home/alexanderforsythe08/.local/share/vice/vice.log
> >
> > Check the log for details: /home/alexanderforsythe08/.local/share/vice/vice-app.log
> >
> > [OK]

### Conversation Thread

**Kite433** (Author) — *~Apr 7, 2026 ("3 weeks ago")*

> btw im on a debian 12 chromebook

---

**Terence-1** — *~Apr 14, 2026 ("2 weeks ago")*

> i think it might be helpful to send the log

---

**Kite433** (Author) — *~Apr 14, 2026 ("2 weeks ago")*

> Here is the log:
>
> ```
> 2026-04-12 10:56:04,734 [vice-app] INFO: vice-app starting (python=/home/alexanderforsythe08/.local/share/vice/venv/bin/python)
> 2026-04-12 10:56:04,737 [vice-app] ERROR: Failed to load config: No module named 'tomli_w'
> 2026-04-12 10:56:04,737 [vice-app] INFO: Starting daemon: /home/alexanderforsythe08/.local/bin/vice start --no-open-ui
> 2026-04-12 10:56:24,875 [vice-app] INFO: Waiting for server at http://localhost:8765/
> 2026-04-12 10:56:24,875 [vice-app] ERROR: Server did not start within 20 s
> 2026-04-12 10:56:24,875 [vice-app] ERROR: Startup diagnostics:
> Daemon IPC socket did not become ready.
>
> No daemon log output was found at /home/alexanderforsythe08/.local/share/vice/vice.log
> 2026-04-12 10:56:24,875 [vice-app] ERROR: UI error: Vice started but the UI server did not respond.
>
> Daemon IPC socket did not become ready.
>
> No daemon log output was found at /home/alexanderforsythe08/.local/share/vice/vice.log
>
> Check the log for details:
> /home/alexanderforsythe08/.local/share/vice/vice-app.log
> ```

---

**yogoswaggins-boop** — *~Apr 14, 2026 ("2 weeks ago") — edited by yogoswaggins-boop*

> I had the same error and got around the tomli_w issue by installing that directly:
>
> ```
> sudo apt install python3-tomli-w
> ```
>
> After that, I have the following error:
>
> ```
> 2026-04-13 11:32:00,557 [vice-app] INFO: vice-app starting (python=/home/.../.local/share/vice/venv/bin/pyt...
> 2026-04-13 11:32:00,569 [vice-app] INFO: Starting daemon: /home/.../.local/bin/vice start --no-open-ui
> 2026-04-13 11:32:20,703 [vice-app] INFO: Waiting for server at http://localhost:8765/
> 2026-04-13 11:32:20,703 [vice-app] ERROR: Server did not start within 20 s
> 2026-04-13 11:32:20,703 [vice-app] ERROR: Startup diagnostics:
> Daemon IPC socket did not become ready.
> ```
>
> After that, I ran vice and vice-app from the console and got further errors leading me to install more packages:
>
> ```
> sudo apt install python3-aiohttp
> sudo apt install python3-webview
> ```
>
> Now vice launches, but I got a browser window with another error:
>
> ```
> Could not connect to localhost. Connection refused.
> ```
>
> Restarting vice after some time finally got me into the application, but the clips page says `Cannot reach daemon`. This appears to be because the daemon isn't running. When attempting to start the daemon with `vice start`, I get this error:
>
> ```
> 11:49:30 [vice] INFO: Vice daemon startup requested (python=/home/.../.local/share/vice/venv/bin/python)
> 11:49:30 [vice] INFO: Runtime environment at daemon start: {'HOME': '/home/...', 'XDG_RUNTIME_DIR': '/run/user/i...
> 11:49:30 [vice] WARNING: Found stale IPC socket at /tmp/vice/vice.sock, removing it
> 11:49:30 [vice.recorder] INFO: Selected backend: wf-recorder (Wayland segment mode)
> 11:49:30 [vice.recorder] INFO: NVIDIA GPU detected → using h264_nvenc
> 11:49:30 [vice.share] INFO: Vice local control UI: http://127.0.0.1:8765
> 11:49:30 [vice.share] INFO: Vice public share server: http://192.168.10.73:8766
> 11:49:30 [vice.share] INFO: Vice legacy share compatibility URL: http://192.168.10.73:8765
> 11:49:30 [vice.share] INFO: Starting Cloudflare Tunnel on port 8766
> 11:49:30 [vice.hotkey] WARNING: No keyboard devices found in /dev/input/. Ensure the udev uaccess rule is install...
> 11:49:30 [vice.recorder] INFO: Starting segment recorder (backend=wf-recorder, encoder=h264_nvenc)
> 11:49:30 [vice.recorder] ERROR: Segment recorder did not produce output: compositor doesn't support wlr-screencop...
> Traceback (most recent call last):
>   File "/home/.../.local/bin/vice", line 6, in <module>
>     sys.exit(cli())
>              ^^^^^
>   File "/usr/lib/python3/dist-packages/click/core.py", line 1157, in __call__
>     return self.main(*args, **kwargs)
>            ^^^^^^^^^^^^^^^^^^^^^^^^^
>   File "/usr/lib/python3/dist-packages/click/core.py", line 1078, in main
>     rv = self.invoke(ctx)
>          ^^^^^^^^^^^^^^^
>   File "/usr/lib/python3/dist-packages/click/core.py", line 1688, in invoke
>     return _process_result(sub_ctx.command.invoke(sub_ctx))
>                            ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
>   File "/usr/lib/python3/dist-packages/click/core.py", line 1434, in invoke
>     return ctx.invoke(self.callback, **ctx.params)
>            ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
>   File "/usr/lib/python3/dist-packages/click/core.py", line 783, in invoke
>     return __callback(*args, **kwargs)
>            ^^^^^^^^^^^^^^^^^^^^^^^^^^
>   File "/home/.../.local/share/vice/venv/lib/python3.12/site-packages/vice/main.py", line 661, in start
>     asyncio.run(daemon.run())
>   File "/usr/lib/python3.12/asyncio/runners.py", line 194, in run
>     return runner.run(main)
>            ^^^^^^^^^^^^^^^
>   File "/usr/lib/python3.12/asyncio/runners.py", line 118, in run
>     return self._loop.run_until_complete(task)
>            ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
>   File "/usr/lib/python3.12/asyncio/base_events.py", line 687, in run_until_complete
>     return future.result()
>            ^^^^^^^^^^^^^^
>   File "/home/.../.local/share/vice/venv/lib/python3.12/site-packages/vice/main.py", line 126, in run
>     await self.recorder.start()
>   File "/home/.../.local/share/vice/venv/lib/python3.12/site-packages/vice/recorder.py", line 1288, in start
>     raise RuntimeError(f"{self.name} failed to start: {self._last_segment_error}")
> RuntimeError: wf-recorder failed to start: compositor doesn't support wlr-screencopy-unstable-v1
> Exception ignored in: <function BaseSubprocessTransport.__del__ at 0x7b750812ea20>
> Traceback (most recent call last):
>   File "/usr/lib/python3.12/asyncio/base_subprocess.py", line 126, in __del__
>   File "/usr/lib/python3.12/asyncio/base_subprocess.py", line 104, in close
>   File "/usr/lib/python3.12/asyncio/unix_events.py", line 568, in close
>   File "/usr/lib/python3.12/asyncio/unix_events.py", line 592, in _close
>   File "/usr/lib/python3.12/asyncio/base_events.py", line 795, in call_soon
>   File "/usr/lib/python3.12/asyncio/base_events.py", line 541, in _check_closed
> RuntimeError: Event loop is closed
> ```
>
> The important bit looks to be `ERROR: Segment recorder did not produce output: compositor doesn't support wlr-screencopy-unstable-v1`.

---

**eklonofficial** (Owner) — *~Apr 14, 2026 ("2 weeks ago")*

> Thank you, this is something currently being worked on!

---

*🏷️ **eklonofficial** added the `bug` and `in the works` labels ~Apr 14, 2026 ("2 weeks ago")*

---

**eklonofficial** (Owner) — *~Apr 21, 2026 ("last week")*

> I did just change how the UI works, so can you guys double check if this issue is still present and/or has changed?

---

**eklonofficial** (Owner) — *~Apr 21, 2026 ("last week")*

> Looked into it, this should be fixed when 1.1.2 drops, stay tuned!

---

*🏷️ **eklonofficial** added the `Coming next update` label and removed the `bug` and `in the works` labels ~Apr 21, 2026 ("last week")*

---

**eklonofficial** (Owner) — *~Apr 21, 2026 ("last week")*

> Just release 1.1.2, should be fixed. If you're still having issues let me know and I'll reopen this.

---

*✅ **eklonofficial** closed this as **completed** ~Apr 21, 2026 ("last week")*

---

*🏷️ **eklonofficial** added the `bug` label and removed the `Coming next update` label ~Apr 21, 2026 ("last week")*

---

**Kite433** (Author) — *~Apr 21, 2026 ("last week")*

> hey im still having the same issue even after trying to update and downloading the files stated by yogoswaggins

---

**eklonofficial** (Owner) — *~Apr 21, 2026 ("last week")*

> Did you fully uninstall the old version? Also provide some new logs please

---

*🔄 **eklonofficial** reopened this ~Apr 21, 2026 ("last week")*

---

**Kite433** (Author) — *~Apr 21, 2026 ("last week")*

> i dont know how to uninstall it

---

**eklonofficial** (Owner) — *~Apr 21, 2026 ("last week")*

> If you installed via the script (which you probably did since you're on debian), just open a terminal and run:
>
> ```
> vice uninstall
> ```
>
> say yes to the prompts, except that last one if you want to keep your clips

---

**Kite433** (Author) — *~Apr 23, 2026 ("5 days ago")*

> hey so when i use vice uninstall it gives me this message instead of uninstalling :
>
> ```
> Traceback (most recent call last):
>   File "/home/alexanderforsythe08/.local/bin/vice", line 3, in <module>
>     from vice.main import cli
>   File "/home/alexanderforsythe08/.local/share/vice/venv/lib/python3.11/site-packages/vice/main.py", line 34, in <module>
>     import click
> ModuleNotFoundError: No module named 'click'
> ```

---

**yogoswaggins-boop** — *~Apr 23, 2026 ("5 days ago")*

> I pulled a fresh version to test the changes. Worth noting is I switched from Wayland to X11 between versions.
>
> The new version required a few more installations:
>
> ```
> sudo apt install libavfilter-dev libvadev libdbus-1-dev
> ```
>
> After that, the install script compilation failed with a new compilation error
>
> ```
> [18/50] Compiling C object gpu-screen-recorder.p/src_encoder_video_vulkan.c.o
> FAILED: gpu-screen-recorder.p/src_encoder_video_vulkan.c.o
> cc -Igpu-screen-recorder.p -I. -I.. -I/usr/include/x86_64-linux-gnu -I/usr/include/libdrm -I/usr/include/pipewire...
> ../src/encoder/video/vulkan.c: In function 'get_graphics_queue_family':
> ../src/encoder/video/vulkan.c:166:26: error: 'AVVulkanDeviceContext' has no member named 'nb_qf'
>   166 |     for(int i = 0; i < vv->nb_qf; i++) {
>       |                          ^~
> ../src/encoder/video/vulkan.c:167:14: error: 'AVVulkanDeviceContext' has no member named 'qf'
>   167 |         if(vv->qf[i].flags & VK_QUEUE_GRAPHICS_BIT)
>       |              ^~
> ../src/encoder/video/vulkan.c:168:22: error: 'AVVulkanDeviceContext' has no member named 'qf'
>   168 |             return vv->qf[i].idx;
>       |                      ^~
> ../src/encoder/video/vulkan.c:171:26: error: 'AVVulkanDeviceContext' has no member named 'nb_qf'
>   171 |     for(int i = 0; i < vv->nb_qf; i++) {
>       |                          ^~
> ../src/encoder/video/vulkan.c:172:14: error: 'AVVulkanDeviceContext' has no member named 'qf'
>   172 |         if(vv->qf[i].flags & VK_QUEUE_TRANSFER_BIT)
>       |              ^~
> ../src/encoder/video/vulkan.c:173:22: error: 'AVVulkanDeviceContext' has no member named 'qf'
>   173 |             return vv->qf[i].idx;
>       |                      ^~
> ```
>
> I'm not sure if this one is a dependency issue or not since all the listed dependencies are satisfied:
>
> ```
> Dependency wayland-scanner found: YES 1.23.1 (cached)
> Program /usr/bin/wayland-scanner found: YES (/usr/bin/wayland-scanner)
> Library m found: YES
> Dependency threads found: YES unknown (cached)
> Dependency libavcodec found: YES 60.31.102 (cached)
> Dependency libavformat found: YES 60.16.100 (cached)
> Dependency libavutil found: YES 58.29.100 (cached)
> Dependency x11 found: YES 1.8.7 (cached)
> Dependency xcomposite found: YES 0.4.5 (cached)
> Dependency xrandr found: YES 1.5.2 (cached)
> Dependency xfixes found: YES 6.0.0 (cached)
> Dependency xdamage found: YES 1.1.6 (cached)
> Dependency libpulse found: YES 16.1 (cached)
> Dependency libswresample found: YES 4.12.100 (cached)
> Dependency libavfilter found: YES 9.12.100 (cached)
> Dependency libva found: YES 1.20.0 (cached)
> Dependency libva-drm found: YES 1.20.0 (cached)
> Dependency libdrm found: YES 2.4.125 (cached)
> Dependency wayland-egl found: YES 18.1.0 (cached)
> Dependency wayland-client found: YES 1.23.1 (cached)
> Dependency vulkan found: YES 1.3.280 (cached)
> Dependency libcap found: YES 2.66 (cached)
> Dependency libpipewire-0.3 found: YES 4.12.100 (cached)
> Dependency libspa-0.2 found: YES 0.2 (cached)
> Dependency dbus-1 found: YES 1.14.10 (cached)
> Dependency libdrm found: YES 2.4.125 (cached)
> ```

---

## Issue #49 — HEVC VAAPI Support

**Status:** 🟢 Open
**Opened:** ~Apr 14, 2026 *(displayed as "2 weeks ago" — exact date approximate)* by **Biblioklept** *(edited by Biblioklept)*
**Labels:** *(none)*
**Assignees:** None
**Milestone:** None
**Participants:** Biblioklept

### Original Post

> **Biblioklept** — *~Apr 14, 2026 ("2 weeks ago") — edited by Biblioklept*
>
> FFmpeg supports FFmpeg HEVC (a.k.a. H.265) and OBS supports it, let's add Vice to the list! H.265 (HEVC) offers up to 50% better compression efficiency than H.264 (AVC), allowing for smaller file sizes while maintaining the same video quality.

### Conversation Thread

*(No comments yet)*

---

## Issue #50 — MKV file support

**Status:** 🟢 Open
**Opened:** ~Apr 14, 2026 *(displayed as "2 weeks ago" — exact date approximate)* by **Biblioklept**
**Labels:** `enhancement`, `in the works`
**Assignees:** None
**Milestone:** None
**Participants:** Biblioklept, eklonofficial (Owner)

### Original Post

> **Biblioklept** — *~Apr 14, 2026 ("2 weeks ago")*
>
> Adding MKV support to Vice would be great because MKV is better than MP4 for recording gaming because it supports multiple audio and subtitle tracks, offers greater flexibility, and is more robust against file corruption.

### Conversation Thread

**eklonofficial** (Owner) — *~Apr 14, 2026 ("2 weeks ago")*

> Thanks for the suggestion, I'll look into this!

---

*🏷️ **eklonofficial** added the `enhancement` and `in the works` labels ~Apr 14, 2026 ("2 weeks ago")*

---

## Issue #51 — Add support for AppImage

**Status:** 🟢 Open
**Opened:** ~Apr 14, 2026 *(displayed as "2 weeks ago" — exact date approximate)* by **leandromqrs**
**Labels:** `known limitation`, `enhancement`
**Assignees:** None
**Milestone:** None
**Participants:** leandromqrs, eklonofficial (Owner)

### Original Post

> **leandromqrs** — *~Apr 14, 2026 ("2 weeks ago")*
>
> Thanks for this amazing project :). I have a suggestion that is useful for most of the users, add the appimage package option

### Conversation Thread

**eklonofficial** (Owner) — *~Apr 14, 2026 ("2 weeks ago")*

> I've been trying to find a way to get it to work with Appimages, especially to make Steam Deck support easier, but it's difficult given the permissions and dependencies for this specific project. Flatpak is more likely, but I'll keep looking into this.
>
> *Reactions: ❤️ 1*

---

*🏷️ **eklonofficial** added the `in the works`, `known limitation`, `enhancement` labels and removed the `in the works` label ~Apr 14, 2026 ("2 weeks ago") — net result: `known limitation` + `enhancement` are active*

---

## Issue #53 — Sound not being picked up in clips

**Status:** 🟢 Open
**Opened:** ~Apr 14, 2026 *(displayed as "2 weeks ago" — exact date approximate)* by **penguin0666**
**Labels:** `in the works`
**Assignees:** None
**Milestone:** None
**Participants:** penguin0666, eklonofficial (Owner)

### Original Post

> **penguin0666** — *~Apr 14, 2026 ("2 weeks ago")*
>
> i use pipeweaver and vice isnt capturing my audio for games and discord and such, could you add in a sound selection dropdown by chance like medal does? so we can pick and choose which audio vice captures. my mic works fine just like i said no other audio in clips

### Conversation Thread

**eklonofficial** (Owner) — *~Apr 21, 2026 ("last week")*

> Sounds great, I'll try and fit this in soon!

---

*🏷️ **eklonofficial** added the `in the works` label ~Apr 21, 2026 ("last week")*

---

## Issue #55 — cloudflare tunnel error 1033 when trying to publish

**Status:** 🟢 Open
**Opened:** ~Apr 21, 2026 *(displayed as "last week" — exact date approximate)* by **noor8706**
**Labels:** *(none)*
**Assignees:** None
**Milestone:** None
**Participants:** noor8706 (Author), eklonofficial (Owner)

### Original Post

> **noor8706** — *~Apr 21, 2026 ("last week")*
>
> it wont work i can only access the file from my file manager

### Conversation Thread

**eklonofficial** (Owner) — *~Apr 21, 2026 ("last week")*

> The vice version that's up currently is broken, I'm just publishing a bug fix right now actually

---

**eklonofficial** (Owner) — *~Apr 21, 2026 ("last week")*

> Can you try with v1.1.1? And if it still doesnt work, can you provide logs?

---

**noor8706** (Author) — *~Apr 21, 2026 ("last week")*

> *(Quoting eklonofficial:)*
> > Can you try with v1.1.1? And if it still doesnt work, can you provide logs?
>
> it works now but only when open

---

**eklonofficial** (Owner) — *~Apr 21, 2026 ("last week")*

> What do you mean? Can you provide logs?

---

## Issue #57 — Localhost refused to connect

**Status:** 🟢 Open
**Opened:** Apr 27, 2026 *(displayed as "19 hours ago" — confirmed by log timestamps showing 2026-04-28 01:51)* by **Rainstripes** *(edited by Rainstripes)*
**Labels:** `bug`
**Assignees:** None
**Milestone:** None
**Participants:** Rainstripes (Author), eklonofficial (Owner)

### Original Post

> **Rainstripes** — *Apr 27, 2026 ("19 hours ago") — edited by Rainstripes*
>
> Running Vice opens a QT webpage that says localhost refused to connect.
> Here's the entire log:
>
> ```
> 2026-04-28 01:51:24,823 [vice-app] INFO: vice-app starting (python=/home/USER/.local/share/vice/venv/bin/python, debug=False)
> 2026-04-28 01:51:24,834 [vice-app] WARNING: Removing stale daemon socket at /tmp/vice/vice.sock
> 2026-04-28 01:51:24,835 [vice-app] INFO: Starting daemon: /home/USER/.local/bin/vice start --no-open-ui
> 2026-04-28 01:51:25,105 [vice-app] INFO: Waiting for server at http://localhost:8765/
> 2026-04-28 01:51:25,105 [vice-app] INFO: Server ready at http://localhost:8765/, opening window
> 2026-04-28 01:51:25,197 [vice-app] INFO: Using QtWebEngine (Chromium) backend
> Registered new object after initialization, existing clients won't be notified!
> Registered new object after initialization, existing clients won't be notified!
> Registered new object after initialization, existing clients won't be notified!
> Registered new object after initialization, existing clients won't be notified!
> ```

### Conversation Thread

*🏷️ **eklonofficial** added the `bug` label Apr 28, 2026 ("3 hours ago")*

---

## Issue #58 — Having different hotkeys for different clip durations

**Status:** 🟢 Open
**Opened:** Apr 27, 2026 *(displayed as "17 hours ago")* by **AnarchoBooleanism**
**Labels:** `enhancement`
**Assignees:** None
**Milestone:** None
**Participants:** AnarchoBooleanism, eklonofficial (Owner)

### Original Post

> **AnarchoBooleanism** — *Apr 27, 2026 ("17 hours ago")*
>
> Thank you for creating this project as it does serve a niche for Linux gaming that has not been adequately covered previously. Coming from Medal (on Windows), one feature that I did like was the ability to have any number of hotkeys (mapped to different buttons) that save clips of pre-specified lengths from the buffer. For example, I could have F6 be set to clip the last 60 seconds of the buffer, and then F7 to clip the last 120 seconds. A feature that covers this use case would be very handy, especially in relation to approaching feature parity with other clients on other platforms.

### Conversation Thread

*✏️ **AnarchoBooleanism** changed the title from "Having different hotkeys for different clip duration" to "Having different hotkeys for different clip durations" Apr 27, 2026 ("17 hours ago")*

---

*🏷️ **eklonofficial** added the `enhancement` label Apr 28, 2026 ("3 hours ago")*

---

**eklonofficial** (Owner) — *Apr 28, 2026 ("3 hours ago")*

> This seems like a good idea, glad that you're enjoying Vice! I'll try and get this in for the next update.

---
