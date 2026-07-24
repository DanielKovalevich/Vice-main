"""
Vice clip library — the versioned SQLite source of truth for clip metadata.

Historically Vice identified clips by their *slug* (filename stem) and spread
per-clip data across several JSON files (``playlists.json``, ``views.json``,
``highlights/<slug>.json``, ``editor_project.json``). Slugs are not stable:
renaming a clip changes its slug and a deleted clip number can be reused for a
brand-new recording, which forced fragile rename/delete fan-out and made it
impossible to attach durable metadata (canonical game, edited/raw origin,
editor-export provenance) to a clip.

This module introduces a single ``library.sqlite3`` database in which every clip
has a stable **UUID** identity. The filename stem is kept as a resolvable
*alias* so existing share/media URLs (``/c/{slug}``, ``/v/{slug}``,
``/t/{slug}``) keep working across renames.

The class here is deliberately decoupled from the filesystem and the aiohttp
server: :meth:`ClipLibrary.reconcile` is fed a list of :class:`ObservedFile`
snapshots (slug + device/inode + size/mtime) rather than scanning the disk
itself, so the reconciliation rules can be unit-tested in isolation.

Schema (``PRAGMA user_version`` == :data:`SCHEMA_VERSION`):

* ``clips``             — uuid PK, current slug, origin, canonical game, the
                          file's device/inode/size/mtime, created_at.
* ``slug_aliases``      — every slug a clip has ever been known by; ``is_current``
                          marks the live one. Lets old links resolve after a
                          rename and survives filename reuse.
* ``playlists`` /
  ``playlist_members``  — custom + auto playlists, membership keyed by clip UUID.
* ``views``             — per-clip view counter.
* ``highlights``        — per-clip highlight list (stored as JSON to match the
                          existing on-disk shape).
* ``export_provenance`` — immutable snapshot of an edited clip's sources.
* ``dismissed_auto``    — auto-playlist game keys the user deleted.
* ``meta``              — small key/value bag (e.g. the legacy-import guard).
"""

from __future__ import annotations

import json
import logging
import secrets
import sqlite3
import time
import uuid as _uuid
import zlib
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable, Optional

from .playlists import PL_COLORS, game_key
from .runtime import actual_home_dir

log = logging.getLogger("vice.library")

LIBRARY_PATH = actual_home_dir() / ".local" / "share" / "vice" / "library.sqlite3"

# Bump when the table layout changes; :meth:`ClipLibrary._migrate_schema` upgrades
# older databases in place.
SCHEMA_VERSION = 1

ORIGIN_RAW = "raw"
ORIGIN_EDITED = "edited"

# A clip whose sources span more than one game gets this literal game value so
# the UI can give it a dedicated grouping bucket rather than hiding it under an
# arbitrary single game.
MULTIPLE_GAMES = "Multiple games"

# Filenames Vice's editor produces. Everything else migrates in as raw.
_EDITED_PREFIX = "Vice_Edit_"


def classify_origin(slug: str) -> str:
    """Best-effort raw/edited classification from a filename stem.

    Only used when cataloguing a clip that the library has never seen (first-run
    migration and newly discovered files); afterwards the stored origin wins, so
    a user renaming an edit doesn't silently reclassify it.
    """
    return ORIGIN_EDITED if str(slug).startswith(_EDITED_PREFIX) else ORIGIN_RAW


@dataclass(frozen=True)
class ObservedFile:
    """A clip file as seen on disk during a reconciliation scan.

    ``device`` / ``inode`` come from :func:`os.stat` (``st_dev`` / ``st_ino``)
    and let us follow a file that was renamed outside Vice on the same
    filesystem. They may be ``None`` on platforms/filesystems that don't expose
    a usable inode, in which case reconciliation falls back to slug matching.
    """

    slug: str
    device: Optional[int] = None
    inode: Optional[int] = None
    size: int = 0
    mtime_ns: int = 0

    @classmethod
    def from_path(cls, path: Path) -> "ObservedFile":
        st = path.stat()
        dev = st.st_dev or None
        ino = st.st_ino or None
        return cls(slug=path.stem, device=dev, inode=ino,
                   size=st.st_size, mtime_ns=st.st_mtime_ns)


@dataclass
class ReconcileResult:
    """Summary of what a :meth:`ClipLibrary.reconcile` pass changed."""

    kept: list[str]           # uuids unchanged
    relinked: list[str]       # uuids whose slug followed an external rename
    reused: list[str]         # uuids newly minted because a filename was reused
    added: list[str]          # uuids for files the library had never seen
    pruned: list[str]         # uuids deleted because their file vanished

    def changed(self) -> bool:
        return bool(self.relinked or self.reused or self.added or self.pruned)


def _new_uuid() -> str:
    return str(_uuid.uuid4())


class ClipLibrary:
    """Transactional accessor for the Vice clip database.

    A single instance owns one :class:`sqlite3.Connection`. Writes are wrapped in
    ``BEGIN IMMEDIATE`` transactions via :meth:`transaction`, matching the
    single-writer model of the asyncio share server.
    """

    def __init__(self, path: Optional[Path] = None) -> None:
        self.path = Path(path) if path is not None else LIBRARY_PATH
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # isolation_level=None puts the connection in autocommit mode so our
        # explicit BEGIN IMMEDIATE / COMMIT in transaction() are the sole
        # transaction control (otherwise sqlite3 auto-begins and BEGIN raises).
        self._conn = sqlite3.connect(str(self.path), isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")
        # WAL keeps readers (share links) from blocking the writer.
        try:
            self._conn.execute("PRAGMA journal_mode = WAL")
        except sqlite3.DatabaseError as exc:  # e.g. :memory: or a read-only fs
            log.debug("Could not enable WAL on %s: %s", self.path, exc)
        self._ensure_schema()

    # ── lifecycle ────────────────────────────────────────────────────────────

    def close(self) -> None:
        try:
            self._conn.close()
        except sqlite3.Error:
            pass

    def __enter__(self) -> "ClipLibrary":
        return self

    def __exit__(self, *_exc) -> None:
        self.close()

    class _Tx:
        def __init__(self, conn: sqlite3.Connection) -> None:
            self._conn = conn

        def __enter__(self) -> sqlite3.Connection:
            self._conn.execute("BEGIN IMMEDIATE")
            return self._conn

        def __exit__(self, exc_type, *_rest) -> None:
            if exc_type is None:
                self._conn.commit()
            else:
                self._conn.rollback()

    def transaction(self) -> "ClipLibrary._Tx":
        """Context manager for an atomic write. Commits on success, rolls back on
        any exception so a half-applied metadata edit never persists."""
        return ClipLibrary._Tx(self._conn)

    # ── schema ───────────────────────────────────────────────────────────────

    def _user_version(self) -> int:
        return int(self._conn.execute("PRAGMA user_version").fetchone()[0])

    def _ensure_schema(self) -> None:
        version = self._user_version()
        if version == SCHEMA_VERSION:
            return
        if version > SCHEMA_VERSION:
            log.warning(
                "Library %s is schema v%d, newer than supported v%d; using as-is.",
                self.path, version, SCHEMA_VERSION,
            )
            return
        with self.transaction():
            if version < 1:
                self._create_v1()
            self._conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

    def _create_v1(self) -> None:
        c = self._conn
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS clips (
                uuid        TEXT PRIMARY KEY,
                slug        TEXT NOT NULL,
                origin      TEXT NOT NULL DEFAULT 'raw',
                game        TEXT,
                device      INTEGER,
                inode       INTEGER,
                size        INTEGER NOT NULL DEFAULT 0,
                mtime_ns    INTEGER NOT NULL DEFAULT 0,
                created_at  TEXT NOT NULL DEFAULT ''
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_clips_slug ON clips(slug);
            CREATE INDEX IF NOT EXISTS idx_clips_inode ON clips(device, inode);
            CREATE INDEX IF NOT EXISTS idx_clips_game ON clips(game);

            CREATE TABLE IF NOT EXISTS slug_aliases (
                slug        TEXT NOT NULL,
                uuid        TEXT NOT NULL REFERENCES clips(uuid) ON DELETE CASCADE,
                is_current  INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (slug, uuid)
            );
            CREATE INDEX IF NOT EXISTS idx_alias_slug ON slug_aliases(slug);
            CREATE INDEX IF NOT EXISTS idx_alias_uuid ON slug_aliases(uuid);

            CREATE TABLE IF NOT EXISTS playlists (
                id          TEXT PRIMARY KEY,
                kind        TEXT NOT NULL,
                name        TEXT NOT NULL,
                emoji       TEXT NOT NULL DEFAULT '',
                color1      TEXT NOT NULL DEFAULT '',
                color2      TEXT NOT NULL DEFAULT '',
                game        TEXT,
                edited      INTEGER NOT NULL DEFAULT 0,
                created_at  TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS playlist_members (
                playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
                clip_uuid   TEXT NOT NULL REFERENCES clips(uuid) ON DELETE CASCADE,
                position    INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (playlist_id, clip_uuid)
            );
            CREATE INDEX IF NOT EXISTS idx_members_clip ON playlist_members(clip_uuid);

            CREATE TABLE IF NOT EXISTS views (
                clip_uuid   TEXT PRIMARY KEY REFERENCES clips(uuid) ON DELETE CASCADE,
                count       INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS highlights (
                clip_uuid   TEXT PRIMARY KEY REFERENCES clips(uuid) ON DELETE CASCADE,
                data        TEXT NOT NULL DEFAULT '[]'
            );

            CREATE TABLE IF NOT EXISTS export_provenance (
                clip_uuid   TEXT PRIMARY KEY REFERENCES clips(uuid) ON DELETE CASCADE,
                exported_at TEXT NOT NULL DEFAULT '',
                game        TEXT,
                sources     TEXT NOT NULL DEFAULT '[]'
            );

            CREATE TABLE IF NOT EXISTS dismissed_auto (
                game_key    TEXT PRIMARY KEY
            );
            CREATE TABLE IF NOT EXISTS meta (
                key         TEXT PRIMARY KEY,
                value       TEXT NOT NULL DEFAULT ''
            );
            """
        )

    # ── meta helpers ─────────────────────────────────────────────────────────

    def _get_meta(self, key: str) -> Optional[str]:
        row = self._conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return row["value"] if row else None

    def _set_meta(self, key: str, value: str) -> None:
        self._conn.execute(
            "INSERT INTO meta(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )

    # ── identity / aliases ───────────────────────────────────────────────────

    def resolve_uuid(self, slug: str) -> Optional[str]:
        """Map a slug (current or historical) to a clip UUID.

        Prefers the clip for which the slug is *current*; falls back to the most
        recent historical owner so old share links keep resolving even after the
        slug has been reused by a newer clip.
        """
        row = self._conn.execute(
            "SELECT uuid FROM slug_aliases WHERE slug=? ORDER BY is_current DESC LIMIT 1",
            (slug,),
        ).fetchone()
        return row["uuid"] if row else None

    def current_slug(self, uuid: str) -> Optional[str]:
        row = self._conn.execute("SELECT slug FROM clips WHERE uuid=?", (uuid,)).fetchone()
        return row["slug"] if row else None

    def get_clip(self, uuid: str) -> Optional[dict]:
        row = self._conn.execute("SELECT * FROM clips WHERE uuid=?", (uuid,)).fetchone()
        return dict(row) if row else None

    def get_clip_by_slug(self, slug: str) -> Optional[dict]:
        uuid = self.resolve_uuid(slug)
        return self.get_clip(uuid) if uuid else None

    def list_clips(self) -> list[dict]:
        rows = self._conn.execute("SELECT * FROM clips ORDER BY mtime_ns DESC").fetchall()
        return [dict(r) for r in rows]

    def _set_current_slug(self, conn: sqlite3.Connection, uuid: str, slug: str) -> None:
        """Point ``uuid`` at ``slug``, updating the clips row and alias table so
        the new slug is current and the old one becomes a resolvable historical
        alias."""
        conn.execute("UPDATE slug_aliases SET is_current=0 WHERE uuid=?", (uuid,))
        # A slug can only be *current* for one clip; demote any prior owner.
        conn.execute(
            "UPDATE slug_aliases SET is_current=0 WHERE slug=? AND uuid<>?",
            (slug, uuid),
        )
        conn.execute(
            "INSERT INTO slug_aliases(slug, uuid, is_current) VALUES(?, ?, 1) "
            "ON CONFLICT(slug, uuid) DO UPDATE SET is_current=1",
            (slug, uuid),
        )
        conn.execute("UPDATE clips SET slug=? WHERE uuid=?", (slug, uuid))

    # ── cataloguing ──────────────────────────────────────────────────────────

    def catalog_clip(self, observed: ObservedFile, *, origin: Optional[str] = None,
                     game: Optional[str] = None, uuid: Optional[str] = None,
                     created_at: Optional[str] = None) -> str:
        """Insert a brand-new clip record and return its UUID.

        Callers that already know the origin/game (migration, editor export) pass
        them; otherwise origin is inferred from the filename.
        """
        clip_uuid = uuid or _new_uuid()
        origin = origin or classify_origin(observed.slug)
        created = created_at or datetime.now().isoformat(timespec="seconds")
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO clips(uuid, slug, origin, game, device, inode, size, "
                "mtime_ns, created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                (clip_uuid, observed.slug, origin, game or None, observed.device,
                 observed.inode, observed.size, observed.mtime_ns, created),
            )
            self._set_current_slug(conn, clip_uuid, observed.slug)
            if game:
                self._sync_auto_membership(conn, clip_uuid, None, game)
        return clip_uuid

    def rename_clip(self, uuid: str, new_slug: str) -> None:
        """Record a Vice-managed rename: the UUID is preserved and the old slug
        stays resolvable."""
        with self.transaction() as conn:
            self._set_current_slug(conn, uuid, new_slug)

    def update_file_identity(self, uuid: str, observed: ObservedFile) -> None:
        with self.transaction() as conn:
            conn.execute(
                "UPDATE clips SET device=?, inode=?, size=?, mtime_ns=? WHERE uuid=?",
                (observed.device, observed.inode, observed.size, observed.mtime_ns, uuid),
            )

    def delete_clip(self, uuid: str) -> None:
        """Remove a clip and everything hanging off it (aliases, membership,
        views, highlights, provenance) via ``ON DELETE CASCADE``."""
        with self.transaction() as conn:
            conn.execute("DELETE FROM clips WHERE uuid=?", (uuid,))

    # ── file reconciliation ──────────────────────────────────────────────────

    def reconcile(self, observed: Iterable[ObservedFile]) -> ReconcileResult:
        """Reconcile the catalogue against the files currently on disk.

        Rules (applied in one transaction):

        * **Unchanged** — a stored clip whose current slug is still on disk keeps
          its UUID; its recorded device/inode/size/mtime are refreshed.
        * **External rename** — a file whose slug is unknown but whose
          (device, inode) matches a stored clip whose slug has disappeared is the
          same file moved outside Vice: the UUID is relinked to the new slug.
        * **Filename reuse** — a file whose slug matches a stored clip but whose
          (device, inode) differs is a different file wearing a recycled name:
          the old record is dropped and a fresh UUID is minted.
        * **New** — a file matching nothing is catalogued.
        * **Prune** — stored clips left unmatched after all files are processed
          are deleted immediately (their files are gone).
        """
        observed = list(observed)
        kept: list[str] = []
        relinked: list[str] = []
        reused: list[str] = []
        added: list[str] = []
        pruned: list[str] = []

        with self.transaction() as conn:
            rows = conn.execute("SELECT * FROM clips").fetchall()
            by_slug: dict[str, sqlite3.Row] = {r["slug"]: r for r in rows}
            by_inode: dict[tuple[int, int], sqlite3.Row] = {
                (r["device"], r["inode"]): r
                for r in rows if r["device"] is not None and r["inode"] is not None
            }
            matched: set[str] = set()    # existing uuids kept or relinked
            replaced: set[str] = set()   # existing uuids deleted due to reuse

            def inode_key_of(o: ObservedFile):
                return (o.device, o.inode) if (
                    o.device is not None and o.inode is not None) else None

            # The UNIQUE(clips.slug) index can't be deferred in SQLite, so any
            # transient slug clash during reassignment would abort the scan. Park
            # every existing clip on a unique, collision-proof temporary slug up
            # front; final on-disk slugs are restored below. This makes slug
            # assignment order-independent and safe for every rename topology —
            # two-file swaps, filename reuse, and an external rename onto a name
            # still held by a clip that this same scan will prune.
            for r in rows:
                conn.execute("UPDATE clips SET slug=? WHERE uuid=?",
                             (f"\x00tmp:{r['uuid']}", r["uuid"]))

            # Pass 1 — inode is the strongest identity, so match on it first. This
            # correctly follows external renames and file swaps before any
            # weaker slug-based reasoning runs.
            remaining: list[ObservedFile] = []
            for obs in observed:
                key = inode_key_of(obs)
                row = by_inode.get(key) if key is not None else None
                if row is not None and row["uuid"] not in matched:
                    matched.add(row["uuid"])
                    slug_changed = row["slug"] != obs.slug
                    self._set_current_slug(conn, row["uuid"], obs.slug)
                    self._refresh_identity(conn, row["uuid"], obs)
                    (relinked if slug_changed else kept).append(row["uuid"])
                else:
                    remaining.append(obs)

            # Pass 2 — files whose inode identified no clip. Fall back to the slug.
            for obs in remaining:
                key = inode_key_of(obs)
                row = by_slug.get(obs.slug)
                if row is None or row["uuid"] in matched:
                    # Slug is unknown, or its old owner already moved to another
                    # name (its file was found elsewhere) → this is a new/replacing
                    # file under this name.
                    new_uuid = self._insert_new(conn, obs)
                    (added if row is None else reused).append(new_uuid)
                    continue
                # Slug maps to an as-yet-unmatched clip.
                if key is not None and row["inode"] is not None:
                    # Both sides have inodes and they differ (else pass 1 caught
                    # it): the name now points at a different physical file.
                    conn.execute("DELETE FROM clips WHERE uuid=?", (row["uuid"],))
                    replaced.add(row["uuid"])
                    reused.append(self._insert_new(conn, obs))
                else:
                    # Inode-less on at least one side: trust the slug as identity.
                    self._set_current_slug(conn, row["uuid"], obs.slug)
                    self._refresh_identity(conn, row["uuid"], obs)
                    matched.add(row["uuid"])
                    kept.append(row["uuid"])

            # Prune stored clips whose file is gone (never matched, not replaced).
            for r in rows:
                if r["uuid"] not in matched and r["uuid"] not in replaced:
                    conn.execute("DELETE FROM clips WHERE uuid=?", (r["uuid"],))
                    pruned.append(r["uuid"])

        return ReconcileResult(kept, relinked, reused, added, pruned)

    def _refresh_identity(self, conn: sqlite3.Connection, uuid: str, obs: ObservedFile) -> None:
        conn.execute(
            "UPDATE clips SET device=?, inode=?, size=?, mtime_ns=? WHERE uuid=?",
            (obs.device, obs.inode, obs.size, obs.mtime_ns, uuid),
        )

    def _insert_new(self, conn: sqlite3.Connection, obs: ObservedFile,
                    *, game: Optional[str] = None) -> str:
        clip_uuid = _new_uuid()
        conn.execute(
            "INSERT INTO clips(uuid, slug, origin, game, device, inode, size, "
            "mtime_ns, created_at) VALUES(?,?,?,?,?,?,?,?,?)",
            (clip_uuid, obs.slug, classify_origin(obs.slug), game or None,
             obs.device, obs.inode, obs.size, obs.mtime_ns,
             datetime.now().isoformat(timespec="seconds")),
        )
        self._set_current_slug(conn, clip_uuid, obs.slug)
        return clip_uuid

    # ── canonical game ───────────────────────────────────────────────────────

    def set_game(self, uuid: str, game: Optional[str]) -> None:
        """Set (or clear, with ``None``/empty) a clip's canonical game.

        The auto-game playlist is a *derived view* of this field: changing the
        game moves the clip out of its old auto playlist and into the new one;
        clearing it removes the clip from any auto playlist without touching
        other (custom) memberships.
        """
        game = (game or "").strip() or None
        with self.transaction() as conn:
            row = conn.execute("SELECT game FROM clips WHERE uuid=?", (uuid,)).fetchone()
            if row is None:
                raise KeyError(uuid)
            old = row["game"]
            if old == game:
                return
            conn.execute("UPDATE clips SET game=? WHERE uuid=?", (game, uuid))
            self._sync_auto_membership(conn, uuid, old, game)

    def set_origin(self, uuid: str, origin: str) -> None:
        """Set a clip's raw/edited classification. Once set explicitly it wins
        over the filename-derived guess, so renaming a clip never silently
        reclassifies it."""
        origin = (origin or "").strip().lower()
        if origin not in (ORIGIN_RAW, ORIGIN_EDITED):
            raise ValueError(f"origin must be {ORIGIN_RAW!r} or {ORIGIN_EDITED!r}")
        with self.transaction() as conn:
            row = conn.execute("SELECT 1 FROM clips WHERE uuid=?", (uuid,)).fetchone()
            if row is None:
                raise KeyError(uuid)
            conn.execute("UPDATE clips SET origin=? WHERE uuid=?", (origin, uuid))

    def _sync_auto_membership(self, conn: sqlite3.Connection, uuid: str,
                              old_game: Optional[str], new_game: Optional[str]) -> None:
        """Keep ``auto:<game_key>`` playlist membership in step with the clip's
        canonical game. Deleting an auto playlist never runs through here, so the
        clip's stored game is preserved independently of playlist existence."""
        old_key = game_key(old_game) if old_game else ""
        new_key = game_key(new_game) if new_game else ""
        if old_key and old_key != new_key:
            conn.execute(
                "DELETE FROM playlist_members WHERE playlist_id=? AND clip_uuid=?",
                (f"auto:{old_key}", uuid),
            )
            self._prune_auto_if_empty(conn, f"auto:{old_key}")
        if new_key:
            self._ensure_auto_playlist(conn, new_key, new_game)
            self._add_member(conn, f"auto:{new_key}", uuid)

    def _ensure_auto_playlist(self, conn: sqlite3.Connection, key: str,
                              display_name: Optional[str]) -> None:
        pid = f"auto:{key}"
        exists = conn.execute("SELECT 1 FROM playlists WHERE id=?", (pid,)).fetchone()
        if exists:
            return
        color1, color2 = PL_COLORS[zlib.crc32(key.encode()) % len(PL_COLORS)]
        conn.execute(
            "INSERT INTO playlists(id, kind, name, emoji, color1, color2, game, "
            "edited, created_at) VALUES(?,?,?,?,?,?,?,?,?)",
            (pid, "auto", display_name or key, "", color1, color2,
             display_name or key, 0, datetime.now().isoformat(timespec="seconds")),
        )

    def _prune_auto_if_empty(self, conn: sqlite3.Connection, pid: str) -> None:
        row = conn.execute("SELECT kind, edited FROM playlists WHERE id=?", (pid,)).fetchone()
        if not row or row["kind"] != "auto" or row["edited"]:
            return
        has_members = conn.execute(
            "SELECT 1 FROM playlist_members WHERE playlist_id=? LIMIT 1", (pid,)
        ).fetchone()
        if not has_members:
            conn.execute("DELETE FROM playlists WHERE id=?", (pid,))

    # ── playlist membership ──────────────────────────────────────────────────

    def _add_member(self, conn: sqlite3.Connection, pid: str, uuid: str) -> None:
        pos = conn.execute(
            "SELECT COALESCE(MAX(position), -1) + 1 AS p FROM playlist_members "
            "WHERE playlist_id=?", (pid,)
        ).fetchone()["p"]
        conn.execute(
            "INSERT INTO playlist_members(playlist_id, clip_uuid, position) "
            "VALUES(?,?,?) ON CONFLICT(playlist_id, clip_uuid) DO NOTHING",
            (pid, uuid, pos),
        )

    def set_memberships(self, uuid: str, playlist_ids: Iterable[str]) -> None:
        """Replace a clip's *custom* playlist memberships with ``playlist_ids`` in
        one transaction. Auto playlists are left untouched — they follow the
        canonical game via :meth:`set_game`."""
        wanted = {pid for pid in playlist_ids if not str(pid).startswith("auto:")}
        with self.transaction() as conn:
            current = {
                r["playlist_id"] for r in conn.execute(
                    "SELECT pm.playlist_id FROM playlist_members pm "
                    "JOIN playlists p ON p.id = pm.playlist_id "
                    "WHERE pm.clip_uuid=? AND p.kind<>'auto'", (uuid,)
                ).fetchall()
            }
            for pid in wanted - current:
                if conn.execute("SELECT 1 FROM playlists WHERE id=?", (pid,)).fetchone():
                    self._add_member(conn, pid, uuid)
            for pid in current - wanted:
                conn.execute(
                    "DELETE FROM playlist_members WHERE playlist_id=? AND clip_uuid=?",
                    (pid, uuid),
                )

    def add_to_playlist(self, pid: str, uuid: str) -> None:
        with self.transaction() as conn:
            if not conn.execute("SELECT 1 FROM playlists WHERE id=?", (pid,)).fetchone():
                raise KeyError(pid)
            self._add_member(conn, pid, uuid)

    def remove_from_playlist(self, pid: str, uuid: str) -> None:
        with self.transaction() as conn:
            conn.execute(
                "DELETE FROM playlist_members WHERE playlist_id=? AND clip_uuid=?",
                (pid, uuid),
            )
            self._prune_auto_if_empty(conn, pid)

    def memberships_of(self, uuid: str) -> list[str]:
        rows = self._conn.execute(
            "SELECT playlist_id FROM playlist_members WHERE clip_uuid=?", (uuid,)
        ).fetchall()
        return [r["playlist_id"] for r in rows]

    def playlist_members(self, pid: str) -> list[str]:
        rows = self._conn.execute(
            "SELECT clip_uuid FROM playlist_members WHERE playlist_id=? ORDER BY position",
            (pid,),
        ).fetchall()
        return [r["clip_uuid"] for r in rows]

    def delete_playlist(self, pid: str) -> None:
        """Delete a playlist. For auto playlists the game key is remembered as
        dismissed (so a restart won't rebuild it) but the clips' canonical game
        metadata is left intact."""
        with self.transaction() as conn:
            row = conn.execute("SELECT kind, game FROM playlists WHERE id=?", (pid,)).fetchone()
            if row is None:
                raise KeyError(pid)
            if row["kind"] == "auto":
                key = pid[len("auto:"):] if pid.startswith("auto:") else game_key(row["game"] or "")
                if key:
                    conn.execute(
                        "INSERT OR IGNORE INTO dismissed_auto(game_key) VALUES(?)", (key,)
                    )
            conn.execute("DELETE FROM playlists WHERE id=?", (pid,))

    def create_custom_playlist(self, name: str, emoji: str = "",
                               color1: str = "", color2: str = "") -> dict:
        name = (name or "").strip()
        if not name:
            raise ValueError("Playlist name is required")
        count = self._conn.execute("SELECT COUNT(*) AS c FROM playlists").fetchone()["c"]
        d1, d2 = PL_COLORS[count % len(PL_COLORS)]
        pid = f"pl-{int(time.time() * 1000)}-{secrets.token_hex(2)}"
        row = {
            "id": pid, "kind": "custom", "name": name, "emoji": emoji,
            "color1": color1 or d1, "color2": color2 or d2, "game": None,
            "edited": 0, "created_at": datetime.now().isoformat(timespec="seconds"),
        }
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO playlists(id, kind, name, emoji, color1, color2, game, "
                "edited, created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                (row["id"], row["kind"], row["name"], row["emoji"], row["color1"],
                 row["color2"], row["game"], row["edited"], row["created_at"]),
            )
        return row

    def list_playlists(self) -> list[dict]:
        """Return playlists with their member UUIDs attached (``clip_uuids``)."""
        rows = self._conn.execute("SELECT * FROM playlists").fetchall()
        out: list[dict] = []
        for r in rows:
            members = self.playlist_members(r["id"])
            out.append(dict(r, clip_uuids=members))
        return out

    # ── views ────────────────────────────────────────────────────────────────

    def bump_view(self, uuid: str) -> int:
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO views(clip_uuid, count) VALUES(?, 1) "
                "ON CONFLICT(clip_uuid) DO UPDATE SET count = count + 1",
                (uuid,),
            )
            return conn.execute(
                "SELECT count FROM views WHERE clip_uuid=?", (uuid,)
            ).fetchone()["count"]

    def views_of(self, uuid: str) -> int:
        row = self._conn.execute(
            "SELECT count FROM views WHERE clip_uuid=?", (uuid,)
        ).fetchone()
        return row["count"] if row else 0

    def set_views(self, uuid: str, count: int) -> None:
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO views(clip_uuid, count) VALUES(?, ?) "
                "ON CONFLICT(clip_uuid) DO UPDATE SET count=excluded.count",
                (uuid, int(count)),
            )

    # ── highlights ───────────────────────────────────────────────────────────

    def get_highlights(self, uuid: str) -> list:
        row = self._conn.execute(
            "SELECT data FROM highlights WHERE clip_uuid=?", (uuid,)
        ).fetchone()
        if not row:
            return []
        try:
            return json.loads(row["data"])
        except (json.JSONDecodeError, TypeError):
            return []

    def set_highlights(self, uuid: str, highlights: list) -> None:
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO highlights(clip_uuid, data) VALUES(?, ?) "
                "ON CONFLICT(clip_uuid) DO UPDATE SET data=excluded.data",
                (uuid, json.dumps(highlights)),
            )

    # ── export provenance (immutable) ────────────────────────────────────────

    def record_provenance(self, uuid: str, sources: list[dict],
                          game: Optional[str] = None,
                          exported_at: Optional[str] = None) -> None:
        """Freeze the source snapshot for an edited clip. Written once; a second
        call for the same clip is ignored so provenance can never be mutated."""
        when = exported_at or datetime.now().isoformat(timespec="seconds")
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO export_provenance(clip_uuid, exported_at, game, sources) "
                "VALUES(?,?,?,?) ON CONFLICT(clip_uuid) DO NOTHING",
                (uuid, when, game or None, json.dumps(sources)),
            )

    def get_provenance(self, uuid: str) -> Optional[dict]:
        row = self._conn.execute(
            "SELECT * FROM export_provenance WHERE clip_uuid=?", (uuid,)
        ).fetchone()
        if not row:
            return None
        try:
            sources = json.loads(row["sources"])
        except (json.JSONDecodeError, TypeError):
            sources = []
        return {"exported_at": row["exported_at"], "game": row["game"], "sources": sources}

    @staticmethod
    def infer_game(source_games: Iterable[Optional[str]]) -> Optional[str]:
        """Derive an edited clip's game from its sources: the shared game when all
        tagged sources agree, else :data:`MULTIPLE_GAMES`, else ``None``."""
        distinct = {g.strip() for g in source_games if g and g.strip()}
        if not distinct:
            return None
        if len(distinct) == 1:
            return next(iter(distinct))
        return MULTIPLE_GAMES

    # ── legacy migration ─────────────────────────────────────────────────────

    _LEGACY_FLAG = "legacy_imported"

    def migrate_legacy_stores(self, observed: Iterable[ObservedFile], *,
                              playlists: Optional[dict] = None,
                              views: Optional[dict] = None,
                              highlights: Optional[dict] = None,
                              editor_project: Optional[dict] = None,
                              tag_index: Optional[dict] = None) -> bool:
        """Import the pre-SQLite JSON stores into the database, once.

        Idempotent: guarded by a ``meta`` flag so re-running (or running against
        an already-populated library) is a no-op. The whole import runs in one
        transaction — if anything raises, it rolls back and the flag stays unset,
        leaving the legacy JSON files as the source of truth for a retry.

        ``observed`` seeds the clip catalogue (each file becomes a clip with a
        UUID); the other arguments are the parsed contents of ``playlists.json``,
        ``views.json``, the per-slug highlight files, and ``editor_project.json``.
        ``tag_index`` maps sanitized game keys to display names for backfilling a
        game onto uncatalogued raw clips from their filename tag.

        Returns ``True`` if the import ran, ``False`` if it was already done.
        """
        if self._get_meta(self._LEGACY_FLAG) == "1":
            return False

        observed = list(observed)
        playlists = playlists or {}
        views = views or {}
        highlights = highlights or {}
        tag_index = tag_index or {}

        with self.transaction() as conn:
            # Re-check inside the transaction to avoid a double import race.
            if self._get_meta(self._LEGACY_FLAG) == "1":
                return False

            slug_to_uuid: dict[str, str] = {}
            for obs in observed:
                uuid = self._insert_new(conn, obs)
                slug_to_uuid[obs.slug] = uuid

            # Playlists + membership. Auto playlists also stamp the clip's game.
            for pl in playlists.get("playlists", []):
                if not isinstance(pl, dict) or not pl.get("id"):
                    continue
                pid = pl["id"]
                kind = pl.get("kind", "custom")
                game = pl.get("game")
                conn.execute(
                    "INSERT OR REPLACE INTO playlists(id, kind, name, emoji, color1, "
                    "color2, game, edited, created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                    (pid, kind, pl.get("name", ""), pl.get("emoji", ""),
                     pl.get("color1", ""), pl.get("color2", ""), game,
                     1 if pl.get("edited") else 0,
                     pl.get("created_at", datetime.now().isoformat(timespec="seconds"))),
                )
                for pos, slug in enumerate(pl.get("clip_slugs", [])):
                    uuid = slug_to_uuid.get(slug)
                    if not uuid:
                        continue
                    conn.execute(
                        "INSERT OR IGNORE INTO playlist_members(playlist_id, clip_uuid, "
                        "position) VALUES(?,?,?)", (pid, uuid, pos),
                    )
                    if kind == "auto" and game:
                        conn.execute(
                            "UPDATE clips SET game=? WHERE uuid=? AND game IS NULL",
                            (game, uuid),
                        )

            for key in playlists.get("dismissed_auto", []):
                if key:
                    conn.execute(
                        "INSERT OR IGNORE INTO dismissed_auto(game_key) VALUES(?)", (str(key),)
                    )

            # Views.
            for slug, count in views.items():
                uuid = slug_to_uuid.get(slug)
                if uuid:
                    conn.execute(
                        "INSERT OR REPLACE INTO views(clip_uuid, count) VALUES(?, ?)",
                        (uuid, int(count)),
                    )

            # Highlights (one JSON list per slug).
            for slug, hl in highlights.items():
                uuid = slug_to_uuid.get(slug)
                if uuid:
                    conn.execute(
                        "INSERT OR REPLACE INTO highlights(clip_uuid, data) VALUES(?, ?)",
                        (uuid, json.dumps(hl)),
                    )

            # Backfill a game from the filename tag for still-uncatalogued raw
            # clips (item 5: filename backfill only touches records with no game).
            self._backfill_games_from_filenames(conn, slug_to_uuid, tag_index)

            self._set_meta(self._LEGACY_FLAG, "1")
        return True

    def _backfill_games_from_filenames(self, conn: sqlite3.Connection,
                                       slug_to_uuid: dict[str, str],
                                       tag_index: dict) -> None:
        import re
        tagged = re.compile(r"^Vice_(?:Clip|Session)_\d+_(?P<tag>.+)$")
        for slug, uuid in slug_to_uuid.items():
            row = conn.execute("SELECT game FROM clips WHERE uuid=?", (uuid,)).fetchone()
            if row is None or row["game"]:
                continue
            m = tagged.match(slug)
            if not m:
                continue
            tag = m.group("tag")
            display = tag_index.get(game_key(tag), tag.replace("-", " "))
            conn.execute("UPDATE clips SET game=? WHERE uuid=?", (display, uuid))

    def legacy_imported(self) -> bool:
        return self._get_meta(self._LEGACY_FLAG) == "1"
