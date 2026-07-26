from __future__ import annotations

from pathlib import Path
from typing import Optional

from .runtime import actual_home_dir

FIRESHARE_TOKEN_PATH = (
    actual_home_dir() / ".local" / "share" / "vice" / "secrets" / "fireshare.token"
)


def load_fireshare_token(path: Path = FIRESHARE_TOKEN_PATH) -> Optional[str]:
    try:
        token = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return token or None


def save_fireshare_token(token: str, path: Path = FIRESHARE_TOKEN_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text((token or "").strip() + "\n", encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass
