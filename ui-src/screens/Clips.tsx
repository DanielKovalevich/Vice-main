import {useState} from 'react';

import {useStore} from '../state/store';
import {useClipActions} from '../state/clipActions';
import {api} from '../lib/api';
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
  const count = visibleClips.length;
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
            : playlist
              ? 'This playlist is empty. Drag a clip onto it, or right-click a clip to add it.'
              : `No clips yet. Press ${hotkey} to save the last ${config?.recording?.clip_duration ?? 20} seconds.`}
        </p>
      ) : (
        <div className="clip-grid">
          {visibleClips.map(clip => (
            <ClipCard
              key={clip.slug}
              clip={clip}
              draggable
              isNew={recentNew.includes(clip.slug)}
              actions={actions}
            />
          ))}
        </div>
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
