import type {Clip} from './types';

/**
 * Pure helpers for the YouTube upload modal.
 *
 * Kept out of the component so they can be exercised directly: the template
 * expansion has to agree with the daemon's own, and getting it wrong shows up
 * as a wrong video title on someone's channel rather than as a crash.
 */

/** MM:SS, which is the only shape an upload timer ever needs. */
export function elapsedLabel(startedAt: string | undefined, now: number): string {
  if (!startedAt) return '0:00';
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return '0:00';
  const secs = Math.max(0, Math.floor((now - started) / 1000));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The filename without its extension, matching clipTitle(). */
const titleOf = (clip: Pick<Clip, 'name'>) => clip.name.replace(/\.(mp4|mkv|mov|webm)$/i, '');

/**
 * Expand a connector's title template for one clip.
 *
 * $filename, $game, $date and $time, each replaced once, mirroring the
 * daemon. Newlines are collapsed because YouTube titles are a single line and
 * a template pulled from a description field can carry them in.
 */
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
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

/**
 * Which connector to preselect: the one last used, else one named after the
 * clip's game, else the first. The game match is what makes per-game
 * connectors worth configuring at all.
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
