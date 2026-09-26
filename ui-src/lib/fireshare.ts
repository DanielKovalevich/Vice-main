import type {FireShareState} from './types';

/**
 * Progress arrives many times a second, coalesced but not ordered, so a single
 * late event applied blindly walks the bar backwards or overwrites a terminal
 * state that already landed. Kept pure so it can be tested directly.
 */

export interface PublishView {
  state: FireShareState;
  progress: number;
  publicUrl: string;
  error: string;
}

export interface PublishEventLike {
  attempt_id: string;
  seq: number;
  state?: FireShareState;
  progress_pct?: number;
  public_url?: string;
  error_message?: string;
}

export const TERMINAL_STATES: FireShareState[] = ['ready', 'uploaded', 'retryable_ambiguous', 'failed', 'stale', 'canceled'];

export const isTerminal = (state: FireShareState): boolean => TERMINAL_STATES.includes(state);

export const emptyPublishView = (): PublishView => ({
  state: 'idle',
  progress: 0,
  publicUrl: '',
  error: '',
});

/**
 * Apply one publish event, or return null when it must be ignored.
 *
 * `seq` is per attempt and restarts, so a caller beginning a new attempt must
 * reset `lastSeq` to -1 or the opening ticks look stale.
 */
export function applyPublishEvent(
  view: PublishView,
  event: PublishEventLike,
  attemptId: string | null,
  lastSeq: number,
): {view: PublishView; seq: number} | null {
  // A retry must never be scribbled on by the attempt it replaced.
  if (!attemptId || event.attempt_id !== attemptId) return null;
  if (typeof event.seq === 'number' && event.seq <= lastSeq) return null;

  const next: PublishView = {
    state: event.state ?? view.state,
    // Terminal messages often carry no progress, and must not reset the bar.
    progress: typeof event.progress_pct === 'number' ? event.progress_pct : view.progress,
    publicUrl: event.public_url || view.publicUrl,
    error: event.error_message || view.error,
  };

  // However far behind the last tick was, ready means done.
  if (next.state === 'ready' || next.state === 'uploaded') next.progress = 100;

  return {view: next, seq: typeof event.seq === 'number' ? event.seq : lastSeq};
}

export interface UploadDestinations {
  default_folder: string;
  folders: string[];
  games: {id: number; name: string}[];
  folder_rules: {folder: string; game_id: number}[];
}

export function validUploadFolder(folder: string): boolean {
  return folder.length > 0 && folder.length <= 255 && folder === folder.trim()
    && !folder.startsWith('.') && !/[\\/\u0000-\u001f\u007f]/.test(folder);
}

export function suggestDestination(
  gameName: string | null,
  options: UploadDestinations,
  fallbackFolder = '',
  previous?: {folder?: string | null; game_id?: number | null} | null,
): {folder: string; gameId: string; needsFolderChoice: boolean} {
  const matches = options.games.filter(g => g.name.toLowerCase() === gameName?.toLowerCase());
  const selected = options.games.find(g => g.id === previous?.game_id)
    ?? (matches.length === 1 ? matches[0] : undefined);
  const mapped = selected ? options.folder_rules.filter(r => r.game_id === selected.id) : [];
  const saved = previous?.folder || fallbackFolder;
  return {
    folder: previous?.folder || (mapped.length === 1 ? mapped[0].folder : fallbackFolder),
    gameId: selected ? String(selected.id) : gameName ? 'choose' : '',
    needsFolderChoice: mapped.length > 1 && !saved,
  };
}
