import {useState} from 'react';

import {useStore} from '../state/store';
import {api} from '../lib/api';
import {usePlaylistDropTarget} from '../lib/clipDrag';
import {formatDuration} from '../lib/format';
import {PlaylistModal, type PlaylistDraft} from './PlaylistModal';
import {ContextMenu} from './ContextMenu';
import {Modal} from './Modal';
import {Wordmark} from './Wordmark';
import type {Playlist, ViewName} from '../lib/types';
import {
  IconAbout,
  IconClips,
  IconDownload,
  IconHelp,
  IconEditor,
  IconHome,
  IconMark,
  IconPlaylist,
  IconPlus,
  IconSearch,
  IconSettings,
} from './Icons';

const NAV: {view: ViewName; label: string; Icon: typeof IconHome}[] = [
  {view: 'home', label: 'Home', Icon: IconHome},
  {view: 'clips', label: 'All Clips', Icon: IconClips},
  {view: 'editor', label: 'Editor', Icon: IconEditor},
  {view: 'settings', label: 'Settings', Icon: IconSettings},
  {view: 'about', label: 'About', Icon: IconAbout},
];

/* Emoji a game playlist would actually reach for. Deliberately not the generic
   smiley and thumbs-up set: each of these has to read as a kind of game at
   15px in a sidebar. */
const GAME_EMOJI = ['\u{1F3AE}', '\u{1F579}\uFE0F', '\u{1F3C6}', '\u2694\uFE0F',
  '\u{1F4A5}', '\u{1F3CE}\uFE0F', '\u{1F680}', '\u{1F47E}'];

export function SideNav({
  onShowTutorial,
  onShowUpdate,
}: {
  onShowTutorial: () => void;
  onShowUpdate: () => void;
}) {
  const {state, dispatch, notify, refreshPlaylists} = useStore();
  const [creating, setCreating] = useState(false);
  const [menu, setMenu] = useState<{playlist: Playlist; at: {x: number; y: number}} | null>(null);
  const [editing, setEditing] = useState<Playlist | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Playlist | null>(null);
  const {view, currentPlaylistId, searchQuery, playlists, clips, config} = state;

  const buffer = config?.recording?.buffer_duration as number | undefined;

  return (
    <nav className="sidenav" aria-label="Main">
      <div className="sidenav-brand">
        <IconMark size={19} className="sidenav-mark" />
        <Wordmark height={15} />
      </div>

      <div className="sidenav-search">
        <IconSearch size={15} />
        <input
          type="search"
          value={searchQuery}
          placeholder="Search clips"
          aria-label="Search clips"
          onChange={e => {
            dispatch({type: 'setSearch', query: e.target.value});
            if (e.target.value && view !== 'clips') dispatch({type: 'setView', view: 'clips'});
          }}
        />
      </div>

      <ul className="sidenav-list">
        {NAV.map(({view: target, label, Icon}) => {
          const active = view === target && !(target === 'clips' && currentPlaylistId);
          return (
            <li key={target}>
              <button
                type="button"
                className="nav-item"
                aria-current={active ? 'page' : undefined}
                onClick={() =>
                  dispatch({
                    type: 'setView',
                    view: target,
                    playlistId: target === 'clips' ? null : undefined,
                  })
                }>
                <Icon size={17} />
                <span>{label}</span>
                {target === 'clips' && clips.length > 0 ? (
                  <span className="nav-count">{clips.length}</span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>

      <div className="sidenav-heading">
        <span>Playlists</span>
        <button
          type="button"
          className="sidenav-add"
          title="New playlist"
          aria-label="New playlist"
          onClick={() => setCreating(true)}>
          <IconPlus size={13} />
        </button>
      </div>
      {playlists.length > 0 ? (
        <ul className="sidenav-list sidenav-playlists">
          {playlists.map(playlist => (
            <PlaylistRow
              key={playlist.id}
              playlist={playlist}
              active={currentPlaylistId === playlist.id}
              onOpen={() => dispatch({type: 'setView', view: 'clips', playlistId: playlist.id})}
              onContextMenu={at => setMenu({playlist, at})}
              onDone={(message, tone) =>
                notify({
                  kind: tone === 'error' ? 'error' : 'info',
                  title: message,
                  tone,
                  holdMs: tone === 'error' ? 7000 : 3000,
                })
              }
            />
          ))}
        </ul>
      ) : (
        <p className="sidenav-empty">Drag a clip here to start one.</p>
      )}

      <div className="sidenav-foot">
        {state.update?.version ? (
          <button
            type="button"
            className="update-chip"
            onClick={onShowUpdate}
            title={`Vice ${state.update.version} is available`}>
            <IconDownload size={12} />
            <span>Update</span>
          </button>
        ) : null}
        <div className="sidenav-foot-row">
          {buffer ? (
            <>
              <span className="sidenav-foot-key">Buffer</span>
              <span className="sidenav-foot-value">{formatDuration(buffer, true)}</span>
            </>
          ) : null}
          <button
            type="button"
            className="sidenav-help"
            onClick={onShowTutorial}
            title="Quick start"
            aria-label="Quick start">
            <IconHelp size={14} />
          </button>
        </div>
      </div>
      <PlaylistModal
        open={creating}
        editing={null}
        onClose={() => setCreating(false)}
        onSubmit={async (draft: PlaylistDraft) => {
          const result = await api.createPlaylist(draft);
          if (result.ok === false) throw new Error(result.error || 'Could not create the playlist');
          await refreshPlaylists();
          dispatch({type: 'setView', view: 'clips', playlistId: result.playlist.id});
          notify({
            kind: 'info',
            title: `Playlist "${draft.name}" created`,
            tone: 'accent',
            holdMs: 3500,
          });
          setCreating(false);
        }}
      />
      {menu ? (
        <ContextMenu
          at={menu.at}
          heading={menu.playlist.name}
          emptyLabel="No actions"
          onClose={() => setMenu(null)}
          quick={GAME_EMOJI.map(glyph => ({
            id: glyph,
            glyph,
            title: `Use ${glyph}`,
            active: menu.playlist.emoji === glyph,
            onSelect: () => {
              const target = menu.playlist;
              void api
                .updatePlaylist(target.id, {emoji: glyph})
                .then(async result => {
                  if (result?.ok === false) {
                    throw new Error(result.error || 'Could not set the emoji');
                  }
                  await refreshPlaylists();
                })
                .catch((err: Error) =>
                  notify({
                    kind: 'error',
                    title: 'Could not set the emoji',
                    detail: err.message,
                    tone: 'error',
                    holdMs: 7000,
                  }),
                );
            },
          }))}
          items={[
            {
              id: 'open',
              label: 'Open',
              onSelect: () =>
                dispatch({type: 'setView', view: 'clips', playlistId: menu.playlist.id}),
            },
            {id: 'edit', label: 'Edit playlist', onSelect: () => setEditing(menu.playlist)},
            {id: 'sep', separator: true},
            {
              id: 'delete',
              label: 'Delete playlist',
              danger: true,
              onSelect: () => setConfirmDelete(menu.playlist),
            },
          ]}
        />
      ) : null}

      <PlaylistModal
        open={editing !== null}
        editing={editing}
        onClose={() => setEditing(null)}
        onSubmit={async (draft: PlaylistDraft) => {
          if (!editing) return;
          const result = await api.updatePlaylist(editing.id, draft);
          if (result.ok === false) throw new Error(result.error || 'Could not update the playlist');
          await refreshPlaylists();
          notify({kind: 'info', title: 'Playlist updated', tone: 'accent', holdMs: 3000});
          setEditing(null);
        }}
      />

      <Modal
        open={confirmDelete !== null}
        title="Delete this playlist?"
        onClose={() => setConfirmDelete(null)}
        footer={
          <>
            <button type="button" className="btn btn-quiet" onClick={() => setConfirmDelete(null)}>
              Keep it
            </button>
            <button
              type="button"
              className="btn btn-danger-solid"
              onClick={() => {
                const target = confirmDelete;
                setConfirmDelete(null);
                if (!target) return;
                void api
                  .deletePlaylist(target.id)
                  .then(async () => {
                    await refreshPlaylists();
                    if (currentPlaylistId === target.id) {
                      dispatch({type: 'setView', view: 'clips', playlistId: null});
                    }
                    notify({
                      kind: 'info',
                      title: 'Playlist deleted',
                      tone: 'neutral',
                      holdMs: 3000,
                    });
                  })
                  .catch((err: Error) =>
                    notify({
                      kind: 'error',
                      title: 'Could not delete the playlist',
                      detail: err.message,
                      tone: 'error',
                      holdMs: 7000,
                    }),
                  );
              }}>
              Delete
            </button>
          </>
        }>
        <p>
          The clips themselves stay put. Only the playlist goes.
          {confirmDelete?.kind === 'auto'
            ? ' This one was created automatically, so Vice will not build it again for this game.'
            : ''}
        </p>
      </Modal>
    </nav>
  );
}

/** One playlist in the rail, which doubles as a drop target for clips. */
function PlaylistRow({
  playlist,
  active,
  onOpen,
  onContextMenu,
  onDone,
}: {
  playlist: Playlist;
  active: boolean;
  onOpen: () => void;
  onContextMenu: (at: {x: number; y: number}) => void;
  onDone: (message: string, tone: 'accent' | 'error') => void;
}) {
  const drop = usePlaylistDropTarget(playlist, onDone);
  return (
    <li>
      <button
        type="button"
        className="nav-item"
        data-drop-over={drop.over || undefined}
        data-received={drop.caught || undefined}
        aria-current={active ? 'page' : undefined}
        onClick={onOpen}
        onContextMenu={e => {
          e.preventDefault();
          onContextMenu({x: e.clientX, y: e.clientY});
        }}
        {...drop.props}>
        <span className="playlist-mark" aria-hidden="true">
          {playlist.emoji || <IconPlaylist size={14} />}
        </span>
        <span className="nav-label">{playlist.name}</span>
        <span className="nav-count">{playlist.clip_slugs?.length ?? 0}</span>
      </button>
    </li>
  );
}
