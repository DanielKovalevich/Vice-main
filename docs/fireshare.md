# Publishing to stock Fireshare

Vice supports the official Fireshare upload-token API introduced in **1.8.3**.
A custom Fireshare build is no longer required.

## Setup

1. In Fireshare, create an upload token under **Settings → Security → Upload Tokens**.
2. In Vice's FireShare settings, enter the server's public HTTPS URL, save the token,
   and validate the connection. Tokens stay in Vice's protected secret file.
3. Open a clip's **Publish to FireShare** dialog. Check its folder and game, then publish.

The former fork's machine token is not an upstream upload token. Replace it during
the server migration. This Vice build requires the official endpoints and cannot
publish to the old machine-only fork; coordinate the two upgrades.

## Folders and games

Vice loads the server's actual games, upload folders, default folder, and folder rules.
An unambiguous, case-insensitive match for the clip's game suggests its Fireshare game
ID and its mapped folder. Multiple matching game names or multiple destination folders
require an explicit choice. You can select another game or a new valid top-level
folder, including names with spaces. Add missing games in Fireshare, then reopen the
publish dialog.

**Use folder rules only** follows the selected folder's game mapping. If that folder
has no rule, Vice sends no explicit game assignment. Conflicting folder/game choices
are blocked in both the dialog and backend. The backend refreshes options before
transferring bytes so a removed game or changed folder rule is checked again.
Fireshare's acceptance response must report the expected folder.

## Immediate links and status

Vice computes the same ID as Fireshare: an `xxh3_128` digest of the first 16 MiB of
the exact bytes streamed to the server. After a `201 accepted` response, Vice persists
and displays `<public-server-url>/w/<video-id>` immediately. **Uploaded** means the file
was accepted, not that all scanning/transcoding has finished. The link may need a moment
before playback works. There is no polling of the fork's retired job endpoint.

A `409 duplicate` response becomes **Already uploaded** and exposes the existing URL.
It does not relocate or re-tag the existing clip. Vice therefore does not record the
newly requested folder/game as the duplicate's actual destination.

Interrupted transfers are explicitly retryable. Stock Fireshare handles duplicate
videos, but does not provide the old server's idempotency-key guarantee. Vice retains
its local full-file SHA-256 retry guard to prevent retrying a changed clip as the same
publication. Old saved links remain usable after updating Vice; acknowledged legacy
jobs become Uploaded, while unconfirmed sends require a manual retry.

Uploads follow Fireshare's configured privacy defaults. Per-upload privacy overrides
from the custom API are not supported. Old explicit-privacy retry requests are rejected
with instructions to start a new publication, rather than silently ignoring the choice.

## Building this branch

Use the existing build/install workflow. The new Python dependency `xxhash>=3.5.0`
is included in `pyproject.toml`, `requirements.txt`, the Arch package, and `install.sh`.
Rebuild UI assets when building from source:

```bash
npm ci
npm run build
./install.sh
```

Use your existing Python installation method if you do not normally use `install.sh`.

## Validation

- Real multipart HTTP tests cover acceptance, streaming hashes across the 16 MiB
  boundary, folder/game resolution, conflicts, duplicates, redirects, and errors.
- Persistence tests cover immediate link storage and restart recovery.
- UI tests cover destination suggestions, ambiguous mappings, valid folder names,
  and Uploaded/uncertain-upload terminal states.
- End-to-end validation against the official `shaneisrael/fireshare:1.8.3` image
  confirmed a generated clip's stored directory and game ID after scanning, immediate
  URL return on acceptance, and duplicate handling without destination changes.
