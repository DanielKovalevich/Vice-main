import type {Clip} from './types';

/**
 * Export resolution and frame rate for the editor.
 *
 * Every rule here mirrors vice/editor.py, because the daemon validates the
 * project again on save and export. Anything this lets through that the
 * daemon rejects becomes an error at export time, which is the worst moment
 * to discover a resolution is not allowed.
 */

export const MIN_FPS = 1;
export const MAX_FPS = 240;
export const MIN_RESOLUTION = 64;
export const MAX_RESOLUTION = 7680;
export const MAX_RESOLUTION_PIXELS = 7680 * 4320;

export interface Resolution {
  width: number;
  height: number;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Even-sized and within range, or null. Matches normalize_resolution(). */
export function normalizeResolution(value: unknown): Resolution | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as {width?: unknown; height?: unknown};
  const width = Number(raw.width);
  const height = Number(raw.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width < MIN_RESOLUTION || height < MIN_RESOLUTION) return null;
  if (width > MAX_RESOLUTION || height > MAX_RESOLUTION) return null;
  // Odd dimensions are rejected outright rather than nudged: H.264 chroma
  // subsampling needs even sides, and silently changing what someone typed is
  // worse than telling them.
  if (width % 2 || height % 2) return null;
  if (width * height > MAX_RESOLUTION_PIXELS) return null;
  return {width, height};
}

/** Matches normalize_fps(). Booleans are rejected like the daemon does. */
export function normalizeFps(value: unknown): number | null {
  if (typeof value === 'boolean') return null;
  const fps = Number(value);
  if (!Number.isFinite(fps) || fps < MIN_FPS || fps > MAX_FPS) return null;
  return round3(fps);
}

/** Matches resolutions_share_aspect(), including its 0.2% tolerance. */
export function shareAspect(a: Resolution, b: Resolution): boolean {
  if (Math.min(a.width, a.height, b.width, b.height) <= 0) return false;
  const lhs = a.width * b.height;
  const rhs = b.width * a.height;
  return Math.abs(lhs - rhs) <= Math.max(lhs, rhs) * 0.002;
}

/** Short edges offered, largest first. */
const SHORT_EDGES = [2160, 1440, 1080, 720];

/**
 * Resolutions matching the canvas aspect at each standard short edge.
 *
 * Derived from the viewport rather than hard-coded, so a vertical or
 * ultra-wide project is offered sizes that actually fit it. Anything that
 * fails the daemon's rules, or repeats, is dropped.
 */
export function presetResolutions(viewport: Resolution | null): Resolution[] {
  if (!viewport) return [];
  const {width, height} = viewport;
  if (width <= 0 || height <= 0) return [];
  const portrait = height >= width;
  const seen = new Set<string>();
  const out: Resolution[] = [];

  for (const edge of SHORT_EDGES) {
    const scale = portrait ? edge / width : edge / height;
    const candidate = normalizeResolution({
      // Round to even in the same step, so a 0.5 never lands on an odd number.
      width: Math.round((width * scale) / 2) * 2,
      height: Math.round((height * scale) / 2) * 2,
    });
    if (!candidate) continue;
    // Only offer sizes that are genuinely the same shape; rounding a very odd
    // aspect to even numbers can drift off it.
    if (!shareAspect(viewport, candidate)) continue;
    const key = `${candidate.width}x${candidate.height}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

/** The frame rates worth offering, including the broadcast fractionals. */
export const FPS_PRESETS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 120, 144];

/** 59.94 stays 59.94; 60 does not become 60.000. */
export function formatFps(fps: number): string {
  const rounded = round3(fps);
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

export const resolutionValue = (r: Resolution): string => `${r.width}x${r.height}`;

export function resolutionFromValue(value: string): Resolution | null {
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(value.trim().toLowerCase().replace('×', 'x'));
  if (!match) return null;
  return normalizeResolution({width: Number(match[1]), height: Number(match[2])});
}

/**
 * The frame rate a project would export at with no override: the highest of
 * its sources, which is what the daemon's project_fps() settles on.
 */
export function sourceFps(clips: Pick<Clip, 'fps'>[]): number {
  const rates = clips.map(c => Number(c.fps) || 0).filter(f => f >= MIN_FPS && f <= MAX_FPS);
  return rates.length ? round3(Math.max(...rates)) : 60;
}

/** The distinct games among an edit's source clips, for the export tagger. */
export function sourceGames(clips: Pick<Clip, 'game'>[]): string[] {
  const names = new Set<string>();
  clips.forEach(c => c.game && names.add(c.game));
  return [...names].sort((a, b) => a.localeCompare(b, undefined, {sensitivity: 'base'}));
}

/**
 * What to tag an export with when the user has not chosen: the single game
 * behind it, or "Multiple games" when the sources disagree. Matches the
 * daemon's own classification so an untouched export is tagged the same way
 * whether the UI guessed or the daemon did.
 */
export const MULTIPLE_GAMES = 'Multiple games';

export function inferExportGame(clips: Pick<Clip, 'game'>[]): string {
  const games = sourceGames(clips);
  if (games.length === 0) return '';
  return games.length === 1 ? games[0] : MULTIPLE_GAMES;
}
