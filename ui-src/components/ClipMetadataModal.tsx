import {useEffect, useId, useMemo, useState} from 'react';

import {api} from '../lib/api';
import {clipTitle, type Clip, type ClipOrigin} from '../lib/types';
import {useStore} from '../state/store';
import {Modal} from './Modal';

/** The literal the daemon uses when an edited clip's sources disagree. */
const MULTIPLE_GAMES = 'Multiple games';

/**
 * Per-clip metadata: game, raw versus edited, and custom playlist membership.
 *
 * The daemon answers with the updated clip and the full playlist set, because
 * changing a game can move a clip between auto playlists. Both are applied
 * straight to the store so the grid updates as the modal closes.
 */
export function ClipMetadataModal({
  clip,
  onClose,
}: {
  clip: Clip | null;
  onClose: () => void;
}) {
  const {state, dispatch, notify} = useStore();
  const listId = useId();

  const [game, setGame] = useState('');
  const [origin, setOrigin] = useState<ClipOrigin>('raw');
  const [playlistIds, setPlaylistIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  // Custom playlists only: auto playlists follow the game, and a checkbox
  // should not be able to contradict that.
  const customPlaylists = useMemo(
    () => state.playlists.filter(p => p.kind === 'custom'),
    [state.playlists],
  );

  // Autocomplete, so the same game does not acquire three spellings.
  const knownGames = useMemo(() => {
    const custom = (state.config?.discord?.custom_games ?? []) as {name?: string}[];
    const names = new Set<string>();
    state.clips.forEach(c => c.game && names.add(c.game));
    custom.forEach(g => g?.name && names.add(g.name));
    names.add(MULTIPLE_GAMES);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [state.clips, state.config]);

  // Reseed whenever a different clip is opened.
  useEffect(() => {
    if (!clip) return;
    setGame(clip.game ?? '');
    setOrigin(clip.origin === 'edited' ? 'edited' : 'raw');
    setPlaylistIds(
      state.playlists.filter(p => p.clip_slugs?.includes(clip.slug)).map(p => p.id),
    );
    setSaving(false);
    // Deliberately not reacting to playlists: that would discard ticks the
    // user has just changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip?.slug]);

  if (!clip) return null;

  const save = () => {
    setSaving(true);
    void api
      .setClipMetadata(clip.slug, {
        game: game.trim() || null,
        origin,
        playlist_ids: playlistIds.filter(id =>
          customPlaylists.some(p => p.id === id),
        ),
      })
      .then(result => {
        if (result.ok === false) throw new Error(result.error || 'Could not save the changes');
        dispatch({
          type: 'setClips',
          clips: state.clips.map(c => (c.slug === result.clip.slug ? result.clip : c)),
        });
        if (result.playlists) dispatch({type: 'setPlaylists', playlists: result.playlists});
        notify({kind: 'info', title: 'Clip updated', tone: 'accent', holdMs: 2500});
        onClose();
      })
      .catch((err: Error) => {
        notify({
          kind: 'error',
          title: 'Could not save the changes',
          detail: err.message,
          tone: 'error',
          holdMs: 7000,
        });
      })
      .finally(() => setSaving(false));
  };

  const sources = clip.provenance?.sources ?? [];

  return (
    <Modal
      open={clip !== null}
      title="Configure clip"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn" disabled={saving} onClick={save}>
            {saving ? 'Saving' : 'Save'}
          </button>
        </>
      }>
      <p className="meta-clip-name">{clipTitle(clip)}</p>

      <label className="meta-field">
        <span>Game</span>
        <input
          className="text-input"
          list={listId}
          value={game}
          placeholder="Untagged"
          spellCheck={false}
          onChange={e => setGame(e.target.value)}
        />
        <datalist id={listId}>
          {knownGames.map(name => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </label>

      <label className="meta-field">
        <span>Type</span>
        <select
          className="select"
          value={origin}
          onChange={e => setOrigin(e.target.value as ClipOrigin)}>
          <option value="raw">Raw recording</option>
          <option value="edited">Edited export</option>
        </select>
      </label>

      {customPlaylists.length ? (
        <div className="meta-field">
          <span>Playlists</span>
          <div className="meta-playlists">
            {customPlaylists.map(playlist => (
              <label key={playlist.id} className="meta-check">
                <input
                  type="checkbox"
                  checked={playlistIds.includes(playlist.id)}
                  onChange={e =>
                    setPlaylistIds(prev =>
                      e.target.checked
                        ? [...prev, playlist.id]
                        : prev.filter(id => id !== playlist.id),
                    )
                  }
                />
                <span>
                  {playlist.emoji ? `${playlist.emoji} ` : ''}
                  {playlist.name}
                </span>
              </label>
            ))}
          </div>
        </div>
      ) : null}

      {origin === 'edited' && sources.length ? (
        <div className="meta-field">
          <span>Built from</span>
          <ul className="meta-sources">
            {sources.map(source => (
              <li key={source.slug}>
                {source.slug}
                {source.game ? <em> · {source.game}</em> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Modal>
  );
}
