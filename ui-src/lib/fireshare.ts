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

export const TERMINAL_STATES: FireShareState[] = ['ready', 'failed', 'stale', 'canceled'];

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
  if (next.state === 'ready') next.progress = 100;

  return {view: next, seq: typeof event.seq === 'number' ? event.seq : lastSeq};
}
