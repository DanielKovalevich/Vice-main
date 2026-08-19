import {api} from './api';

/**
 * One preview volume shared by every video in the app, persisted server-side.
 *
 * Upstream has no volume handling: the viewer, the trim modal and the editor
 * each show a video and each would otherwise start at full volume, so setting
 * it once and having it stick is the whole feature.
 *
 * It lives in app-state rather than localStorage for the same reason the other
 * cross-session UI flags do: the native window's localStorage does not survive
 * a restart on every QtWebEngine build.
 */

const SAVE_DEBOUNCE_MS = 250;

let current = 1;
/**
 * Set while this module is writing volume onto an element, so the resulting
 * `volumechange` is recognised as our own and not treated as a user action.
 * Without it, applying the stored value would immediately re-save it, and any
 * rounding would walk the value on every clip that opened.
 */
let applying = false;
let saveTimer: number | undefined;
let saveFailed = false;

const listeners = new Set<(volume: number) => void>();

export const clampVolume = (raw: unknown): number => {
  const value = Number(raw);
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
};

export const getPreviewVolume = (): number => current;

export function subscribePreviewVolume(fn: (volume: number) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Push the current volume onto one element without tripping the guard. */
export function applyVolume(video: HTMLVideoElement): void {
  applying = true;
  try {
    video.volume = current;
  } finally {
    // Cleared on a later tick: the volumechange event this triggers is
    // dispatched asynchronously, so clearing it synchronously would let the
    // echo through as though the user had moved the slider.
    setTimeout(() => {
      applying = false;
    }, 0);
  }
}

export function applyToAllVideos(): void {
  document.querySelectorAll('video').forEach(applyVolume);
}

/**
 * Record a new volume and schedule a save.
 *
 * `fromUser` is false when the value came from the daemon, which must not be
 * written straight back.
 */
export function setPreviewVolume(
  raw: unknown,
  {fromUser = true, onError}: {fromUser?: boolean; onError?: (message: string) => void} = {},
): void {
  const next = clampVolume(raw);
  if (next === current) return;
  current = next;
  listeners.forEach(fn => fn(next));
  applyToAllVideos();
  if (!fromUser) return;

  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void api
      .setAppState({preview_volume: current})
      .then(() => {
        saveFailed = false;
      })
      .catch((err: Error) => {
        // Report once. A slider that toasts on every drag is unusable, and the
        // failure is the same one each time.
        if (!saveFailed) {
          saveFailed = true;
          onError?.(err.message);
        }
      });
  }, SAVE_DEBOUNCE_MS);
}

export async function loadPreviewVolume(): Promise<void> {
  try {
    const state = await api.getAppState();
    if (state && 'preview_volume' in state) {
      setPreviewVolume(state.preview_volume, {fromUser: false});
    }
  } catch {
    // Full volume is a fine default when app-state cannot be read.
  }
}

/**
 * Install the listeners that keep every video in step.
 *
 * Both are on the document in the capture phase so they cover videos that
 * mount later, which is every one of them: the viewer, the trim modal and the
 * editor all appear long after this runs.
 */
export function watchVideos(onError?: (message: string) => void): () => void {
  const onLoaded = (event: Event) => {
    const video = event.target as HTMLVideoElement | null;
    if (video?.tagName === 'VIDEO') applyVolume(video);
  };
  const onVolumeChange = (event: Event) => {
    if (applying) return;
    const video = event.target as HTMLVideoElement | null;
    if (video?.tagName !== 'VIDEO') return;
    // Muting is a separate control from volume, and treating a mute as
    // "volume 0" would lose the level the user set when they unmute.
    if (video.muted) return;
    setPreviewVolume(video.volume, {onError});
  };

  document.addEventListener('loadedmetadata', onLoaded, true);
  document.addEventListener('volumechange', onVolumeChange, true);
  return () => {
    document.removeEventListener('loadedmetadata', onLoaded, true);
    document.removeEventListener('volumechange', onVolumeChange, true);
  };
}
