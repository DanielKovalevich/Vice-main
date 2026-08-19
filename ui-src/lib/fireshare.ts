import type {FireShareState} from './types';

/**
 * The publish state one modal is showing, and the rule for advancing it.
 *
 * This is deliberately a pure function rather than logic inside the component.
 * It is the part of FireShare publishing that is easy to get quietly wrong:
 * progress arrives many times a second, coalesced but not ordered, and a
 * single late tick applied blindly can walk the bar backwards or, worse,
 * overwrite a terminal state that already landed.
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
 * Apply one publish event.
 *
 * Returns the next view, or null when the event must be ignored, which is the
 * case when:
 *
 *   * it belongs to a different attempt, so a retry is never scribbled on by
 *     the attempt it replaced; or
 *   * its `seq` is not newer than the highest already seen, which is how a
 *     late or duplicated tick is kept from regressing the view.
 *
 * `seq` is per attempt and restarts, so a caller beginning a new attempt must
 * reset `lastSeq` to -1 or the new attempt's opening ticks look stale.
 */
export function applyPublishEvent(
  view: PublishView,
  event: PublishEventLike,
  attemptId: string | null,
  lastSeq: number,
): {view: PublishView; seq: number} | null {
  if (!attemptId || event.attempt_id !== attemptId) return null;
  if (typeof event.seq === 'number' && event.seq <= lastSeq) return null;

  const next: PublishView = {
    state: event.state ?? view.state,
    // A message that carries no progress leaves it alone; terminal messages
    // often omit it and must not reset the bar to zero.
    progress: typeof event.progress_pct === 'number' ? event.progress_pct : view.progress,
    publicUrl: event.public_url || view.publicUrl,
    error: event.error_message || view.error,
  };

  // Reaching "ready" means the upload is done, whatever the last progress tick
  // managed to say before it.
  if (next.state === 'ready') next.progress = 100;

  return {view: next, seq: typeof event.seq === 'number' ? event.seq : lastSeq};
}
