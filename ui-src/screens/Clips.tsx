import {useEffect, useMemo, useState} from 'react';

import {useStore} from '../state/store';
import {useClipActions} from '../state/clipActions';
import {api} from '../lib/api';
import {
  GROUP_BY_LABELS,
  LEGACY_GROUP_KEY,
  TYPE_FILTER_LABELS,
  filterByType,
  groupClips,
  normalizeGroupBy,
  normalizeTypeFilter,
  type GroupBy,
  type TypeFilter,
} from '../lib/clipGrouping';
import {ClipCard} from '../components/ClipCard';
import {ContextMenu} from '../components/ContextMenu';
import {PlaylistModal, type PlaylistDraft} from '../components/PlaylistModal';
import {Modal} from '../components/Modal';
import {IconMore, IconWarning} from '../components/Icons';

export function Clips() {
  const {state, dispatch, visibleClips, hotkey, notify, refreshPlaylists} = useStore();
  const {playlists, currentPlaylistId, searchQuery, recentNew, status, config} = state;

  const playlist = currentPlaylistId
    ? (playlists.find(p => p.id === currentPlaylistId) ?? null)
    : null;

  const {actions, overlays} = useClipActions();
  const [editingPlaylist, setEditingPlaylist] = useState<'new' | 'edit' | null>(null);
  const [confirmPlaylistDelete, setConfirmPlaylistDelete] = useState(false);
  const [playlistMenu, setPlaylistMenu] = useState<{x: number; y: number} | null>(null);

  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');

  // Load once, and migrate the key the pre-React fork build wrote. The local
  // key is only cleared after the server has taken the value, so a failed
  // write does not lose the setting.
  useEffect(() => {
    let cancelled = false;
    void api
      .getAppState()
      .then(s => {
        if (cancelled) return;
        const stored = normalizeGroupBy(s.clips_group_by);
        const filter = normalizeTypeFilter(s.clips_type_filter);
        if (filter) setTypeFilter(filter);
        if (stored) {
          setGroupBy(stored);
          return;
        }
        let legacy: string | null = null;
        try {
          legacy = localStorage.getItem(LEGACY_GROUP_KEY);
        } catch {
          // Private mode, or storage disabled. Nothing to migrate.
        }
        const migrated = normalizeGroupBy(legacy);
        if (!migrated) return;
        setGroupBy(migrated);
        void api
          .setAppState({clips_group_by: migrated})
          .then(() => {
            try {
              localStorage.removeItem(LEGACY_GROUP_KEY);
            } catch {
              // Losing the cleanup is harmless; the server value now wins.
            }
          })
          .catch(() => {
            // Keep the local key so the next launch can try again.
          });
      })
      .catch(() => {
        // Defaults are fine when app state cannot be read.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Fire and forget: a failed write is not worth interrupting the grid for.
  const persist = (patch: Record<string, unknown>) => {
    void api.setAppState(patch).catch(() => {});
  };

  // Grouping and filtering are All Clips only. A playlist is already a
  // deliberate selection, and re-cutting it would fight the user.
  const grouped = useMemo(() => {
    if (playlist) return [{key: 'all', label: '', clips: visibleClips}];
    return groupClips(filterByType(visibleClips, typeFilter), groupBy);
  }, [playlist, visibleClips, typeFilter, groupBy]);

  const shownCount = grouped.reduce((total, group) => total + group.clips.length, 0);

  const fail = (title: string) => (err: Error) =>
    notify({kind: 'error', title, detail: err.message, tone: 'error', holdMs: 7000});

  const submitPlaylist = async (draft: PlaylistDraft) => {
    if (editingPlaylist === 'edit' && playlist) {
      const result = await api.updatePlaylist(playlist.id, draft);
      if (result.ok === false) throw new Error(result.error || 'Could not update the playlist');
      await refreshPlaylists();
      notify({kind: 'info', title: 'Playlist updated', tone: 'accent', holdMs: 3000});
    } else {
      const result = await api.createPlaylist(draft);
      if (result.ok === false) throw new Error(result.error || 'Could not create the playlist');
      await refreshPlaylists();
      dispatch({type: 'setView', view: 'clips', playlistId: result.playlist.id});
      notify({kind: 'info', title: `Playlist "${draft.name}" created`, tone: 'accent', holdMs: 3500});
    }
    setEditingPlaylist(null);
  };

  const title = playlist ? playlist.name : 'All Clips';
  const count = shownCount;
  const subtitle = searchQuery.trim()
    ? `${count} match${count === 1 ? '' : 'es'} for "${searchQuery.trim()}"`
    : `${count} clip${count === 1 ? '' : 's'}`;
  const isAuto = playlist?.kind === 'auto';

  return (
    <div className="clips">
      <header className="clips-head">
        <div className="clips-title">
          <h1>
            {playlist?.emoji ? <span className="clips-emoji">{playlist.emoji}</span> : null}
            {title}
          </h1>
          <p>{subtitle}</p>
        </div>

        <div className="clips-tools">
          {playlist ? null : (
            <>
              <select
                className="select"
                aria-label="Filter clips by type"
                value={typeFilter}
                onChange={e => {
                  const next = e.target.value as TypeFilter;
                  setTypeFilter(next);
                  persist({clips_type_filter: next});
                }}>
                {TYPE_FILTER_LABELS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <select
                className="select"
                aria-label="Group clips"
                value={groupBy}
                onChange={e => {
                  const next = e.target.value as GroupBy;
                  setGroupBy(next);
                  persist({clips_group_by: next});
                }}>
                {GROUP_BY_LABELS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </>
          )}
          {playlist ? (
            <button
              type="button"
              className="btn btn-quiet btn-icon-only"
              title="Playlist options"
              aria-label="Playlist options"
              onClick={e => {
                const r = e.currentTarget.getBoundingClientRect();
                setPlaylistMenu({x: r.right - 200, y: r.bottom + 6});
              }}>
              <IconMore size={16} />
            </button>
          ) : null}
          <button type="button" className="btn btn-quiet" onClick={() => setEditingPlaylist('new')}>
            New playlist
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void api.triggerClip().catch(fail('Could not save a clip'))}>
            Save clip
          </button>
        </div>
      </header>

      {status.hotkeys_available === false ? (
        <div className="banner" data-tone="warning" role="status">
          <IconWarning size={17} className="banner-icon" />
          <div className="banner-text">
            <strong>Global hotkeys are not available.</strong>
            <span>
              Vice cannot read your keyboard, so {hotkey} will not save a clip. The Save clip button
              above still works. Adding your user to the input group and logging back in usually
              fixes it.
            </span>
          </div>
        </div>
      ) : null}

      {count === 0 ? (
        <p className="home-empty">
          {searchQuery.trim()
            ? `Nothing matches "${searchQuery.trim()}".`
            : typeFilter !== 'all' && !playlist
              ? `No ${typeFilter} clips.`
              : playlist
                ? 'This playlist is empty. Drag a clip onto it, or right-click a clip to add it.'
                : `No clips yet. Press ${hotkey} to save the last ${config?.recording?.clip_duration ?? 20} seconds.`}
        </p>
      ) : (
        grouped.map(group => (
          <section key={group.key} className="clip-group">
            {group.label ? (
              <h2 className="clip-group-heading">
                <span>{group.label}</span>
                <span className="clip-group-count">
                  {group.clips.length} clip{group.clips.length === 1 ? '' : 's'}
                </span>
              </h2>
            ) : null}
            <div className="clip-grid">
              {group.clips.map(clip => (
                <ClipCard
                  key={clip.slug}
                  clip={clip}
                  draggable
                  isNew={recentNew.includes(clip.slug)}
                  actions={actions}
                />
              ))}
            </div>
          </section>
        ))
      )}

      {playlistMenu && playlist ? (
        <ContextMenu
          at={playlistMenu}
          heading={playlist.name}
          emptyLabel="No actions"
          onClose={() => setPlaylistMenu(null)}
          items={[
            {
              id: 'edit',
              label: 'Edit playlist',
              onSelect: () => setEditingPlaylist('edit'),
            },
            {
              id: 'delete',
              label: 'Delete playlist',
              danger: true,
              onSelect: () => setConfirmPlaylistDelete(true),
            },
          ]}
        />
      ) : null}

      <PlaylistModal
        open={editingPlaylist !== null}
        editing={editingPlaylist === 'edit' ? playlist : null}
        onClose={() => setEditingPlaylist(null)}
        onSubmit={submitPlaylist}
      />

      <Modal
        open={confirmPlaylistDelete}
        title="Delete this playlist?"
        onClose={() => setConfirmPlaylistDelete(false)}
        footer={
          <>
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => setConfirmPlaylistDelete(false)}>
              Keep it
            </button>
            <button
              type="button"
              className="btn btn-danger-solid"
              onClick={() => {
                setConfirmPlaylistDelete(false);
                if (!playlist) return;
                void api
                  .deletePlaylist(playlist.id)
                  .then(async () => {
                    await refreshPlaylists();
                    dispatch({type: 'setView', view: 'clips', playlistId: null});
                    notify({kind: 'info', title: 'Playlist deleted', tone: 'neutral', holdMs: 3000});
                  })
                  .catch(fail('Could not delete the playlist'));
              }}>
              Delete
            </button>
          </>
        }>
        <p>
          The clips themselves stay put. Only the playlist goes.
          {isAuto
            ? ' This one was created automatically, so Vice will not build it again for this game.'
            : ''}
        </p>
      </Modal>

      {overlays}
    </div>
  );
}
