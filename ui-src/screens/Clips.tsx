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
import {t} from '../lib/i18n';
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
  // Buttons that open a ContextMenu, because .select is width:100% for the
  // settings form and stretches the toolbar row.
  const [toolMenu, setToolMenu] = useState<{kind: 'type' | 'group'; x: number; y: number} | null>(
    null,
  );

  // The local key is cleared only after the server takes the value, so a
  // failed write does not lose the setting.
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
          // Storage disabled. Nothing to migrate.
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
              // The server value wins from here either way.
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

  // A playlist is already a deliberate selection, so re-cutting it would
  // fight the user.
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
      if (result.ok === false) throw new Error(result.error || t('clips.errUpdatePlaylist'));
      await refreshPlaylists();
      notify({kind: 'info', title: t('clips.playlistUpdated'), tone: 'accent', holdMs: 3000});
    } else {
      const result = await api.createPlaylist(draft);
      if (result.ok === false) throw new Error(result.error || t('clips.errCreatePlaylist'));
      await refreshPlaylists();
      dispatch({type: 'setView', view: 'clips', playlistId: result.playlist.id});
      notify({
        kind: 'info',
        title: t('clips.playlistCreated', {name: draft.name}),
        tone: 'accent',
        holdMs: 3500,
      });
    }
    setEditingPlaylist(null);
  };

  const title = playlist ? playlist.name : t('clips.allClips');
  const count = shownCount;
  const query = searchQuery.trim();
  const subtitle = query
    ? t('clips.countMatches', {count, query})
    : t('clips.countClips', {count});
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
              <button
                type="button"
                className="btn btn-quiet"
                aria-haspopup="menu"
                onClick={e => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setToolMenu({kind: 'type', x: r.left, y: r.bottom + 6});
                }}>
                {t(TYPE_FILTER_LABELS.find(([value]) => value === typeFilter)?.[1] ?? 'clips.typeAll')}
              </button>
              <button
                type="button"
                className="btn btn-quiet"
                aria-haspopup="menu"
                onClick={e => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setToolMenu({kind: 'group', x: r.left, y: r.bottom + 6});
                }}>
                {t(GROUP_BY_LABELS.find(([value]) => value === groupBy)?.[1] ?? 'clips.groupNone')}
              </button>
            </>
          )}
          {playlist ? (
            <button
              type="button"
              className="btn btn-quiet btn-icon-only"
              title={t('clips.playlistOptions')}
              aria-label={t('clips.playlistOptions')}
              onClick={e => {
                const r = e.currentTarget.getBoundingClientRect();
                setPlaylistMenu({x: r.right - 200, y: r.bottom + 6});
              }}>
              <IconMore size={16} />
            </button>
          ) : null}
          <button type="button" className="btn btn-quiet" onClick={() => setEditingPlaylist('new')}>
            {t('clips.newPlaylist')}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void api.triggerClip().catch(fail(t('clips.errSaveClip')))}>
            {t('clips.saveClip')}
          </button>
        </div>
      </header>

      {status.hotkeys_available === false ? (
        <div className="banner" data-tone="warning" role="status">
          <IconWarning size={17} className="banner-icon" />
          <div className="banner-text">
            <strong>{t('clips.hotkeysUnavailableTitle')}</strong>
            <span>{t('clips.hotkeysUnavailableBody', {hotkey})}</span>
          </div>
        </div>
      ) : null}

      {count === 0 ? (
        <p className="home-empty">
          {query
            ? t('clips.emptySearch', {query})
            : typeFilter !== 'all' && !playlist
              ? t(typeFilter === 'raw' ? 'clips.emptyRaw' : 'clips.emptyEdited')
              : playlist
                ? t('clips.emptyPlaylist')
                : t('clips.emptyLibrary', {
                    hotkey,
                    duration: config?.recording?.clip_duration ?? 20,
                  })}
        </p>
      ) : (
        grouped.map(group => (
          <section key={group.key} className="clip-group">
            {group.label || group.labelKey ? (
              <h2 className="clip-group-heading">
                <span>{group.labelKey ? t(group.labelKey) : group.label}</span>
                <span className="clip-group-count">
                  {t('clips.countClips', {count: group.clips.length})}
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

      {toolMenu ? (
        <ContextMenu
          at={{x: toolMenu.x, y: toolMenu.y}}
          heading={toolMenu.kind === 'type' ? 'Show' : 'Group by'}
          emptyLabel={t('clips.noOptions')}
          onClose={() => setToolMenu(null)}
          items={
            toolMenu.kind === 'type'
              ? TYPE_FILTER_LABELS.map(([value]) => ({
                  id: value,
                  // The heading already says what is being chosen, so the rows
                  // drop the "Type:" prefix the button carries.
                  label: t(`clips.typeOpt.${value}`),
                  mark: value === typeFilter ? '✓' : undefined,
                  onSelect: () => {
                    setTypeFilter(value);
                    persist({clips_type_filter: value});
                  },
                }))
              : GROUP_BY_LABELS.map(([value]) => ({
                  id: value,
                  label: t(`clips.groupOpt.${value}`),
                  mark: value === groupBy ? '✓' : undefined,
                  onSelect: () => {
                    setGroupBy(value);
                    persist({clips_group_by: value});
                  },
                }))
          }
        />
      ) : null}

      {playlistMenu && playlist ? (
        <ContextMenu
          at={playlistMenu}
          heading={playlist.name}
          emptyLabel={t('common.noActions')}
          onClose={() => setPlaylistMenu(null)}
          items={[
            {
              id: 'edit',
              label: t('clips.editPlaylist'),
              onSelect: () => setEditingPlaylist('edit'),
            },
            {
              id: 'delete',
              label: t('clips.deletePlaylist'),
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
        title={t('clips.confirmDeleteTitle')}
        onClose={() => setConfirmPlaylistDelete(false)}
        footer={
          <>
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => setConfirmPlaylistDelete(false)}>
              {t('common.keepIt')}
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
                    notify({
                      kind: 'info',
                      title: t('clips.playlistDeleted'),
                      tone: 'neutral',
                      holdMs: 3000,
                    });
                  })
                  .catch(fail(t('clips.errDeletePlaylist')));
              }}>
              {t('common.delete')}
            </button>
          </>
        }>
        <p>
          {t('clips.confirmDeleteBody')}
          {isAuto ? t('clips.confirmDeleteAuto') : ''}
        </p>
      </Modal>

      {overlays}
    </div>
  );
}
