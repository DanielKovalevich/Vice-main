import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from vice.library import (
    ClipLibrary,
    ObservedFile,
    MULTIPLE_GAMES,
    ORIGIN_EDITED,
    ORIGIN_RAW,
    SCHEMA_VERSION,
    classify_origin,
)


def obs(slug, device=1, inode=None, size=100, mtime_ns=1):
    """Build an ObservedFile, defaulting inode to a stable hash of the slug so
    each distinct filename looks like a distinct physical file unless overridden."""
    if inode is None:
        inode = abs(hash(slug)) % 1_000_000 + 1
    return ObservedFile(slug=slug, device=device, inode=inode, size=size, mtime_ns=mtime_ns)


class SchemaTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "library.sqlite3"

    def test_fresh_database_is_current_version(self):
        lib = ClipLibrary(self.path)
        self.addCleanup(lib.close)
        self.assertEqual(lib._user_version(), SCHEMA_VERSION)

    def test_reopening_does_not_recreate_or_lose_data(self):
        lib = ClipLibrary(self.path)
        uuid = lib.catalog_clip(obs("Vice_Clip_1"))
        lib.close()

        reopened = ClipLibrary(self.path)
        self.addCleanup(reopened.close)
        self.assertEqual(reopened._user_version(), SCHEMA_VERSION)
        self.assertEqual(reopened.current_slug(uuid), "Vice_Clip_1")

    def test_newer_schema_is_left_untouched(self):
        lib = ClipLibrary(self.path)
        lib._conn.execute("PRAGMA user_version = 999")
        lib._conn.commit()
        lib.close()
        # Should not downgrade or wipe.
        reopened = ClipLibrary(self.path)
        self.addCleanup(reopened.close)
        self.assertEqual(reopened._user_version(), 999)

    def test_classify_origin(self):
        self.assertEqual(classify_origin("Vice_Edit_3"), ORIGIN_EDITED)
        self.assertEqual(classify_origin("Vice_Clip_3"), ORIGIN_RAW)
        self.assertEqual(classify_origin("my_render"), ORIGIN_RAW)


class IdentityAliasTests(unittest.TestCase):
    def setUp(self):
        self.lib = ClipLibrary(":memory:")
        self.addCleanup(self.lib.close)

    def test_slug_resolves_to_uuid(self):
        uuid = self.lib.catalog_clip(obs("Vice_Clip_1"))
        self.assertEqual(self.lib.resolve_uuid("Vice_Clip_1"), uuid)

    def test_rename_keeps_uuid_and_old_slug_resolves(self):
        uuid = self.lib.catalog_clip(obs("Vice_Clip_1"))
        self.lib.rename_clip(uuid, "Cool_Play")
        self.assertEqual(self.lib.current_slug(uuid), "Cool_Play")
        self.assertEqual(self.lib.resolve_uuid("Cool_Play"), uuid)
        # Historical slug still resolves to the same clip.
        self.assertEqual(self.lib.resolve_uuid("Vice_Clip_1"), uuid)

    def test_reused_slug_prefers_current_owner(self):
        a = self.lib.catalog_clip(obs("Vice_Clip_1"))
        self.lib.rename_clip(a, "Renamed_A")
        # A different clip later takes the freed "Vice_Clip_1" slug.
        b = self.lib.catalog_clip(obs("Vice_Clip_1", inode=999))
        self.assertEqual(self.lib.resolve_uuid("Vice_Clip_1"), b)
        self.assertNotEqual(a, b)

    def test_unknown_slug_resolves_to_none(self):
        self.assertIsNone(self.lib.resolve_uuid("nope"))


class ReconcileTests(unittest.TestCase):
    def setUp(self):
        self.lib = ClipLibrary(":memory:")
        self.addCleanup(self.lib.close)

    def test_unchanged_files_keep_uuid(self):
        a = self.lib.catalog_clip(obs("Vice_Clip_1", inode=10))
        res = self.lib.reconcile([obs("Vice_Clip_1", inode=10)])
        self.assertEqual(res.kept, [a])
        self.assertFalse(res.changed())

    def test_new_file_is_added(self):
        res = self.lib.reconcile([obs("Vice_Clip_1", inode=10)])
        self.assertEqual(len(res.added), 1)
        self.assertEqual(self.lib.resolve_uuid("Vice_Clip_1"), res.added[0])

    def test_external_rename_relinks_by_inode(self):
        a = self.lib.catalog_clip(obs("Vice_Clip_1", inode=10))
        # Same device/inode, different slug → the file was renamed outside Vice.
        res = self.lib.reconcile([obs("Renamed_Outside", inode=10)])
        self.assertEqual(res.relinked, [a])
        self.assertEqual(self.lib.current_slug(a), "Renamed_Outside")
        self.assertEqual(self.lib.resolve_uuid("Vice_Clip_1"), a)

    def test_filename_reuse_mints_new_uuid(self):
        a = self.lib.catalog_clip(obs("Vice_Clip_1", inode=10))
        # Same slug, different inode → a different file wearing a recycled name.
        res = self.lib.reconcile([obs("Vice_Clip_1", inode=20)])
        self.assertEqual(len(res.reused), 1)
        self.assertNotIn(a, res.reused)
        self.assertIsNone(self.lib.get_clip(a))
        self.assertEqual(self.lib.resolve_uuid("Vice_Clip_1"), res.reused[0])

    def test_vanished_file_is_pruned(self):
        a = self.lib.catalog_clip(obs("Vice_Clip_1", inode=10))
        b = self.lib.catalog_clip(obs("Vice_Clip_2", inode=20))
        res = self.lib.reconcile([obs("Vice_Clip_2", inode=20)])
        self.assertEqual(res.pruned, [a])
        self.assertEqual(res.kept, [b])
        self.assertIsNone(self.lib.get_clip(a))

    def test_prune_only_after_scan_and_membership_cascades(self):
        a = self.lib.catalog_clip(obs("Vice_Clip_1", inode=10))
        pl = self.lib.create_custom_playlist("Faves")
        self.lib.add_to_playlist(pl["id"], a)
        self.assertEqual(self.lib.playlist_members(pl["id"]), [a])
        self.lib.reconcile([])  # file gone
        self.assertEqual(self.lib.playlist_members(pl["id"]), [])

    def test_swap_two_files_relinks_both(self):
        a = self.lib.catalog_clip(obs("A", inode=10))
        b = self.lib.catalog_clip(obs("B", inode=20))
        # Filenames swapped on disk, inodes unchanged.
        res = self.lib.reconcile([obs("B", inode=10), obs("A", inode=20)])
        self.assertEqual(set(res.relinked), {a, b})
        self.assertEqual(self.lib.resolve_uuid("B"), a)
        self.assertEqual(self.lib.resolve_uuid("A"), b)

    def test_external_rename_onto_vanished_clip_slug(self):
        # A's file is renamed (outside Vice) onto B's name, replacing B's file,
        # so only one file remains: name "B" carrying A's inode. The relink must
        # not collide on the UNIQUE(clips.slug) index with the soon-to-be-pruned
        # B; A takes the slug and B is pruned.
        a = self.lib.catalog_clip(obs("A", inode=10))
        b = self.lib.catalog_clip(obs("B", inode=20))
        res = self.lib.reconcile([obs("B", inode=10)])
        self.assertEqual(res.relinked, [a])
        self.assertEqual(res.pruned, [b])
        self.assertEqual(self.lib.current_slug(a), "B")
        self.assertEqual(self.lib.resolve_uuid("B"), a)
        self.assertIsNone(self.lib.get_clip(b))

    def test_reconcile_without_inodes_falls_back_to_slug(self):
        a = self.lib.catalog_clip(ObservedFile("Vice_Clip_1"))
        res = self.lib.reconcile([ObservedFile("Vice_Clip_1")])
        self.assertEqual(res.kept, [a])


class CanonicalGameTests(unittest.TestCase):
    def setUp(self):
        self.lib = ClipLibrary(":memory:")
        self.addCleanup(self.lib.close)

    def test_setting_game_creates_auto_playlist_membership(self):
        uuid = self.lib.catalog_clip(obs("Vice_Clip_1"))
        self.lib.set_game(uuid, "Overwatch 2")
        self.assertEqual(self.lib.get_clip(uuid)["game"], "Overwatch 2")
        self.assertIn("auto:overwatch-2", self.lib.memberships_of(uuid))

    def test_changing_game_moves_auto_membership(self):
        uuid = self.lib.catalog_clip(obs("Vice_Clip_1"))
        self.lib.set_game(uuid, "Overwatch 2")
        self.lib.set_game(uuid, "Valorant")
        memberships = self.lib.memberships_of(uuid)
        self.assertIn("auto:valorant", memberships)
        self.assertNotIn("auto:overwatch-2", memberships)
        # The emptied auto playlist is pruned.
        ids = {p["id"] for p in self.lib.list_playlists()}
        self.assertNotIn("auto:overwatch-2", ids)

    def test_clearing_game_removes_auto_membership_only(self):
        uuid = self.lib.catalog_clip(obs("Vice_Clip_1"))
        custom = self.lib.create_custom_playlist("Best")
        self.lib.add_to_playlist(custom["id"], uuid)
        self.lib.set_game(uuid, "Halo")
        self.lib.set_game(uuid, None)
        self.assertIsNone(self.lib.get_clip(uuid)["game"])
        # Custom membership survives; auto membership is gone.
        self.assertEqual(self.lib.memberships_of(uuid), [custom["id"]])

    def test_deleting_auto_playlist_keeps_game_metadata(self):
        uuid = self.lib.catalog_clip(obs("Vice_Clip_1"))
        self.lib.set_game(uuid, "Halo")
        self.lib.delete_playlist("auto:halo")
        # Game metadata is authoritative and independent of the playlist.
        self.assertEqual(self.lib.get_clip(uuid)["game"], "Halo")

    def test_infer_game(self):
        self.assertIsNone(ClipLibrary.infer_game([None, "", "  "]))
        self.assertEqual(ClipLibrary.infer_game(["Halo", "Halo"]), "Halo")
        self.assertEqual(ClipLibrary.infer_game(["Halo", "Doom"]), MULTIPLE_GAMES)
        self.assertEqual(ClipLibrary.infer_game(["Halo", None]), "Halo")


class MembershipTests(unittest.TestCase):
    def setUp(self):
        self.lib = ClipLibrary(":memory:")
        self.addCleanup(self.lib.close)

    def test_set_memberships_replaces_custom_only(self):
        uuid = self.lib.catalog_clip(obs("Vice_Clip_1"))
        self.lib.set_game(uuid, "Halo")  # auto membership
        a = self.lib.create_custom_playlist("A")
        b = self.lib.create_custom_playlist("B")
        self.lib.set_memberships(uuid, [a["id"]])
        self.assertIn(a["id"], self.lib.memberships_of(uuid))
        self.lib.set_memberships(uuid, [b["id"]])
        memberships = self.lib.memberships_of(uuid)
        self.assertIn(b["id"], memberships)
        self.assertNotIn(a["id"], memberships)
        # Auto membership untouched by custom membership replacement.
        self.assertIn("auto:halo", memberships)

    def test_add_to_missing_playlist_raises(self):
        uuid = self.lib.catalog_clip(obs("Vice_Clip_1"))
        with self.assertRaises(KeyError):
            self.lib.add_to_playlist("nope", uuid)


class ViewsHighlightsTests(unittest.TestCase):
    def setUp(self):
        self.lib = ClipLibrary(":memory:")
        self.addCleanup(self.lib.close)

    def test_view_counter(self):
        uuid = self.lib.catalog_clip(obs("Vice_Clip_1"))
        self.assertEqual(self.lib.views_of(uuid), 0)
        self.assertEqual(self.lib.bump_view(uuid), 1)
        self.assertEqual(self.lib.bump_view(uuid), 2)

    def test_highlights_roundtrip(self):
        uuid = self.lib.catalog_clip(obs("Vice_Clip_1"))
        hl = [{"id": "h1", "time": 1.5, "label": "Nice"}]
        self.lib.set_highlights(uuid, hl)
        self.assertEqual(self.lib.get_highlights(uuid), hl)

    def test_delete_clip_cascades_views_and_highlights(self):
        uuid = self.lib.catalog_clip(obs("Vice_Clip_1"))
        self.lib.bump_view(uuid)
        self.lib.set_highlights(uuid, [{"id": "h1"}])
        self.lib.delete_clip(uuid)
        # Rows are gone (no orphan lookups possible against a fresh uuid).
        self.assertEqual(self.lib.views_of(uuid), 0)
        self.assertEqual(self.lib.get_highlights(uuid), [])


class ProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.lib = ClipLibrary(":memory:")
        self.addCleanup(self.lib.close)

    def test_provenance_is_immutable(self):
        uuid = self.lib.catalog_clip(obs("Vice_Edit_1"), origin=ORIGIN_EDITED)
        first = [{"uuid": "u1", "filename": "Vice_Clip_1", "game": "Halo"}]
        self.lib.record_provenance(uuid, first, game="Halo")
        # A second write must not overwrite the frozen snapshot.
        self.lib.record_provenance(uuid, [{"uuid": "u2"}], game="Doom")
        got = self.lib.get_provenance(uuid)
        self.assertEqual(got["game"], "Halo")
        self.assertEqual(got["sources"], first)

    def test_no_provenance_returns_none(self):
        uuid = self.lib.catalog_clip(obs("Vice_Clip_1"))
        self.assertIsNone(self.lib.get_provenance(uuid))


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "library.sqlite3"

    def _stores(self):
        observed = [obs("Vice_Clip_1", inode=1), obs("Vice_Clip_2_Overwatch-2", inode=2),
                    obs("Vice_Edit_1", inode=3)]
        playlists = {
            "playlists": [
                {"id": "auto:overwatch-2", "kind": "auto", "name": "Overwatch 2",
                 "game": "Overwatch 2", "clip_slugs": ["Vice_Clip_2_Overwatch-2"]},
                {"id": "pl-1", "kind": "custom", "name": "Faves",
                 "clip_slugs": ["Vice_Clip_1", "Vice_Edit_1"]},
            ],
            "dismissed_auto": ["valorant"],
        }
        views = {"Vice_Clip_1": 5, "Vice_Edit_1": 2}
        highlights = {"Vice_Clip_1": [{"id": "h1", "time": 1.0}]}
        return observed, playlists, views, highlights

    def test_migration_imports_all_stores(self):
        lib = ClipLibrary(self.path)
        self.addCleanup(lib.close)
        observed, playlists, views, highlights = self._stores()
        ran = lib.migrate_legacy_stores(
            observed, playlists=playlists, views=views, highlights=highlights,
        )
        self.assertTrue(ran)

        u1 = lib.resolve_uuid("Vice_Clip_1")
        u2 = lib.resolve_uuid("Vice_Clip_2_Overwatch-2")
        ue = lib.resolve_uuid("Vice_Edit_1")

        self.assertEqual(lib.get_clip(ue)["origin"], ORIGIN_EDITED)
        self.assertEqual(lib.get_clip(u1)["origin"], ORIGIN_RAW)
        self.assertEqual(lib.views_of(u1), 5)
        self.assertEqual(lib.get_highlights(u1), [{"id": "h1", "time": 1.0}])
        # Auto playlist stamped the canonical game onto the clip.
        self.assertEqual(lib.get_clip(u2)["game"], "Overwatch 2")
        self.assertIn("pl-1", lib.memberships_of(u1))

    def test_migration_is_idempotent(self):
        lib = ClipLibrary(self.path)
        self.addCleanup(lib.close)
        observed, playlists, views, highlights = self._stores()
        self.assertTrue(lib.migrate_legacy_stores(
            observed, playlists=playlists, views=views, highlights=highlights))
        # A second run is a no-op and does not duplicate clips.
        self.assertFalse(lib.migrate_legacy_stores(
            observed, playlists=playlists, views=views, highlights=highlights))
        self.assertEqual(len(lib.list_clips()), 3)

    def test_migration_survives_restart(self):
        observed, playlists, views, highlights = self._stores()
        lib = ClipLibrary(self.path)
        lib.migrate_legacy_stores(observed, playlists=playlists, views=views,
                                  highlights=highlights)
        lib.close()

        reopened = ClipLibrary(self.path)
        self.addCleanup(reopened.close)
        self.assertTrue(reopened.legacy_imported())
        self.assertFalse(reopened.migrate_legacy_stores(observed))
        self.assertEqual(len(reopened.list_clips()), 3)

    def test_migration_backfills_game_from_filename_tag(self):
        lib = ClipLibrary(self.path)
        self.addCleanup(lib.close)
        observed = [obs("Vice_Clip_9_Deep-Rock-Galactic", inode=9)]
        lib.migrate_legacy_stores(
            observed, tag_index={"deep-rock-galactic": "Deep Rock Galactic"})
        uuid = lib.resolve_uuid("Vice_Clip_9_Deep-Rock-Galactic")
        self.assertEqual(lib.get_clip(uuid)["game"], "Deep Rock Galactic")

    def test_migration_rolls_back_on_error(self):
        lib = ClipLibrary(self.path)
        self.addCleanup(lib.close)
        # A playlist row whose clip_slugs is not iterable-of-str will blow up mid
        # import; the whole transaction must roll back and the flag stay unset.
        bad = {"playlists": [{"id": "pl-x", "kind": "custom", "name": "X",
                              "clip_slugs": 12345}]}
        with self.assertRaises(Exception):
            lib.migrate_legacy_stores([obs("Vice_Clip_1", inode=1)], playlists=bad)
        self.assertFalse(lib.legacy_imported())
        # Nothing partially imported.
        self.assertEqual(lib.list_clips(), [])


if __name__ == "__main__":
    unittest.main()
