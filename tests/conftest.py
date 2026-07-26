"""Test-collection shims.

``vice.runtime`` imports the POSIX-only ``pwd`` module at module load time
(``actual_home_dir()`` uses it, with a Windows-safe fallback at *call* time).
That import happens unconditionally, though, so anything importing
``vice.config``/``vice.library``/``vice.fireshare`` fails to even collect on
Windows. Install a minimal stand-in before any test module imports those, so
the existing runtime fallback logic (which already tolerates a missing/failing
``pwd``) gets exercised instead of blowing up at import time.
"""

from __future__ import annotations

import os
import sys
import types

if os.name == "nt" and "pwd" not in sys.modules:
    _fake_pwd = types.ModuleType("pwd")

    class _struct_passwd:
        def __init__(self, pw_dir: str) -> None:
            self.pw_dir = pw_dir

    def _getpwuid(_uid: int) -> _struct_passwd:
        return _struct_passwd(os.path.expanduser("~"))

    _fake_pwd.getpwuid = _getpwuid  # type: ignore[attr-defined]
    sys.modules["pwd"] = _fake_pwd
