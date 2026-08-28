import {api} from './api';

/**
 * One preview volume for every video, persisted server-side because the native
 * window's localStorage does not survive a restart on every QtWebEngine build.
 */

const SAVE_DEBOUNCE_MS = 250;

let current = 1;
let applying = false;
let saveTimer: number | undefined;
let saveGeneration = 0;

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

export function applyVolume(video: HTMLVideoElement): void {
  applying = true;
  try {
    video.volume = current;
  } finally {
    // The volumechange this triggers is dispatched asynchronously, so clearing
    // the flag synchronously would let the echo through as a user action.
    setTimeout(() => {
      applying = false;
    }, 0);
  }
}

export function applyToAllVideos(): void {
  document.querySelectorAll('video').forEach(applyVolume);
}

/** `fromUser` is false for values that came from the daemon. */
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

  const generation = ++saveGeneration;
  const value = current;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void api
      .setAppState({preview_volume: value})
      .then(() => {
        // A newer slider value may already have superseded this request.
        if (generation !== saveGeneration) return;
      })
      .catch((err: Error) => {
        // Only the latest save can report: stale failures are irrelevant, and
        // the active caller must not be hidden behind another caller's error.
        if (generation === saveGeneration) onError?.(err.message);
      });
  }, SAVE_DEBOUNCE_MS);
}

export async function loadPreviewVolume(): Promise<void> {
  const loadGeneration = saveGeneration;
  try {
    const state = await api.getAppState();
    // Do not let a slow initial read overwrite a choice made while it was in
    // flight; the user's value is already the newer source of truth.
    if (saveGeneration !== loadGeneration) return;
    if (state && 'preview_volume' in state) {
      setPreviewVolume(state.preview_volume, {fromUser: false});
    }
  } catch {
    // Full volume is a fine default when app-state cannot be read.
  }
}

/**
 * Document-level and in the capture phase, because every video in this app
 * mounts long after this runs.
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
    // Reading a mute as volume zero would lose the level to restore on unmute.
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
