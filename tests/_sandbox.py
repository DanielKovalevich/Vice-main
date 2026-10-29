"""Point every store Vice writes under the user's home at a scratch folder.

Imported first by each test module that reaches the stores. Building a
ShareServer backfills playlists against its own clips folder and saves the
result, so a test that skipped a redirect pruned the real playlists.json
(and could touch real highlights, views and caches). Redirecting at import
covers every test, and test_sandbox.py fails when a new store is added
without a line here.
"""

import atexit
import shutil
import tempfile
from pathlib import Path

from vice import editor, fireshare_secrets, keys, library, playlists

try:
    from vice import share
except ModuleNotFoundError:  # aiohttp missing: the share tests skip themselves
    share = None

ROOT = Path(tempfile.mkdtemp(prefix="vice-tests-"))
atexit.register(shutil.rmtree, ROOT, ignore_errors=True)

REDIRECTS = {
    (playlists, "PLAYLISTS_PATH"): ROOT / "playlists.json",
    (editor, "PROJECT_PATH"): ROOT / "editor_project.json",
    (keys, "KEYS_DIR"): ROOT / "keys",
    (library, "LIBRARY_PATH"): ROOT / "library.sqlite3",
    (fireshare_secrets, "FIRESHARE_TOKEN_PATH"): ROOT / "fireshare.token",
}
SHARE_REDIRECTS = {
    "THUMB_DIR": ROOT / "thumbs",
    "PROXY_DIR": ROOT / "proxies",
    "EXPORT_WORK_DIR": ROOT / "exports",
    "HIGHLIGHTS_DIR": ROOT / "highlights",
    "VIEWS_PATH": ROOT / "views.json",
    "SHARE_TOKENS_PATH": ROOT / "share_tokens.json",
    "APP_STATE_PATH": ROOT / "ui_state.json",
    "LIBRARY_PATH": ROOT / "library.sqlite3",
}

if share is not None:
    REDIRECTS.update({(share, name): path for name, path in SHARE_REDIRECTS.items()})

for (module, name), path in REDIRECTS.items():
    setattr(module, name, path)

# These existing functions bind the default path when they are imported.
fireshare_secrets.load_fireshare_token.__defaults__ = (fireshare_secrets.FIRESHARE_TOKEN_PATH,)
fireshare_secrets.save_fireshare_token.__defaults__ = (fireshare_secrets.FIRESHARE_TOKEN_PATH,)
