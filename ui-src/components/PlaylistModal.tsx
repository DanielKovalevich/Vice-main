import {useEffect, useState} from 'react';

import {Modal} from './Modal';
import type {Playlist} from '../lib/types';

/** The gradient pairs a playlist can carry. Order matters: index is stored. */
export const PLAYLIST_COLORS: [string, string][] = [
  ['#ff7a45', '#9a3412'],
  ['#f0b429', '#7c4a03'],
  ['#34d399', '#064e3b'],
  ['#38bdf8', '#075985'],
  ['#8b5cf6', '#3b0a74'],
  ['#f472b6', '#831843'],
  ['#ef4444', '#7f1d1d'],
  ['#a3e635', '#3f6212'],
];

const DEFAULT_COLOR = 4;

export interface PlaylistDraft {
  name: string;
  emoji: string;
  color1: string;
  color2: string;
}

export function PlaylistModal({
  open,
  editing,
  onClose,
  onSubmit,
}: {
  open: boolean;
  /** The playlist being edited, or null when creating a new one. */
  editing: Playlist | null;
  onClose: () => void;
  onSubmit: (draft: PlaylistDraft) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('');
  const [colorIndex, setColorIndex] = useState(DEFAULT_COLOR);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSaving(false);
    if (editing) {
      setName(editing.name);
      setEmoji(editing.emoji ?? '');
      const found = PLAYLIST_COLORS.findIndex(
        ([a, b]) => a === editing.color1 && b === editing.color2,
      );
      setColorIndex(found >= 0 ? found : DEFAULT_COLOR);
    } else {
      setName('');
      setEmoji('');
      setColorIndex(DEFAULT_COLOR);
    }
  }, [open, editing]);

  const [c1, c2] = PLAYLIST_COLORS[colorIndex];

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Give the playlist a name');
      return;
    }
    setSaving(true);
    try {
      await onSubmit({name: trimmed, emoji: emoji.trim(), color1: c1, color2: c2});
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title={editing ? 'Edit playlist' : 'New playlist'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn" onClick={() => void submit()} disabled={saving}>
            {editing ? 'Save' : 'Create'}
          </button>
        </>
      }>
      <div className="npl-head">
        <span
          className="npl-preview"
          style={{background: `linear-gradient(150deg, ${c1}, ${c2})`}}
          aria-hidden="true">
          {emoji.trim()}
        </span>
        <div className="npl-fields">
          <label className="field">
            <span>Name</span>
            <input
              value={name}
              autoFocus
              onChange={e => {
                setName(e.target.value);
                setError(null);
              }}
              onKeyDown={e => e.key === 'Enter' && void submit()}
            />
          </label>
          <label className="field field-narrow">
            <span>Emoji</span>
            <input
              value={emoji}
              maxLength={4}
              placeholder="Optional"
              onChange={e => setEmoji(e.target.value)}
            />
          </label>
        </div>
      </div>

      <div className="npl-colors" role="radiogroup" aria-label="Playlist colour">
        {PLAYLIST_COLORS.map(([a, b], i) => (
          <button
            key={a}
            type="button"
            role="radio"
            aria-checked={i === colorIndex}
            aria-label={`Colour ${i + 1}`}
            className="npl-color"
            data-active={i === colorIndex || undefined}
            style={{background: `linear-gradient(150deg, ${a}, ${b})`}}
            onClick={() => setColorIndex(i)}
          />
        ))}
      </div>

      {error ? <p className="field-error">{error}</p> : null}
    </Modal>
  );
}
