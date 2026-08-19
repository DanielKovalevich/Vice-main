import type {Clip} from './types';

/**
 * Pure helpers for the YouTube upload modal. A wrong title template does not
 * crash, it puts the wrong name on someone's channel, so it is kept testable.
 */

export function elapsedLabel(startedAt: string | undefined, now: number): string {
  if (!startedAt) return '0:00';
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return '0:00';
  // Clamped: the daemon's clock and the browser's need not agree.
  const secs = Math.max(0, Math.floor((now - started) / 1000));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

const pad = (n: number) => String(n).padStart(2, '0');

const titleOf = (clip: Pick<Clip, 'name'>) => clip.name.replace(/\.(mp4|mkv|mov|webm)$/i, '');

/** Mirrors the daemon's expansion, so the field shows what will be uploaded. */
export function renderTitleTemplate(
  template: string,
  clip: Pick<Clip, 'name' | 'game' | 'created_at'>,
): string {
  const created = new Date(clip.created_at);
  const valid = !Number.isNaN(created.getTime());
  return (template || '$filename')
    .replace('$filename', titleOf(clip))
    .replace('$game', clip.game ?? '')
    .replace(
      '$date',
      valid
        ? `${created.getFullYear()}-${pad(created.getMonth() + 1)}-${pad(created.getDate())}`
        : '',
    )
    .replace('$time', valid ? `${pad(created.getHours())}${pad(created.getMinutes())}` : '')
    // A YouTube title is one line, and a template pulled from a description
    // field can carry newlines in.
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

/**
 * Last used, then one named after the game, then the first. The game match is
 * the reason for keeping more than one connector.
 */
export function pickConnector<T extends {id: string; name: string}>(
  connectors: T[],
  lastUsedId: string,
  game: string | null,
): T | null {
  if (!connectors.length) return null;
  const last = connectors.find(c => c.id === lastUsedId);
  if (last) return last;
  if (game) {
    const byGame = connectors.find(c => c.name.toLowerCase() === game.toLowerCase());
    if (byGame) return byGame;
  }
  return connectors[0];
}
