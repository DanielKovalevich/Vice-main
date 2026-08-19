import type {Clip} from './types';

/**
 * Mirrors the rules in vice/editor.py. The daemon answers a bad project with a
 * 400 rather than a correction, so anything allowed here that it rejects
 * becomes a failed export.
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

export function normalizeResolution(value: unknown): Resolution | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as {width?: unknown; height?: unknown};
  const width = Number(raw.width);
  const height = Number(raw.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width < MIN_RESOLUTION || height < MIN_RESOLUTION) return null;
  if (width > MAX_RESOLUTION || height > MAX_RESOLUTION) return null;
  // H.264 chroma subsampling needs even sides. Rejected rather than nudged,
  // because silently changing what someone typed is worse than saying no.
  if (width % 2 || height % 2) return null;
  if (width * height > MAX_RESOLUTION_PIXELS) return null;
  return {width, height};
}

export function normalizeFps(value: unknown): number | null {
  // Booleans coerce to 0 and 1, which the daemon refuses; match it.
  if (typeof value === 'boolean') return null;
  const fps = Number(value);
  if (!Number.isFinite(fps) || fps < MIN_FPS || fps > MAX_FPS) return null;
  return round3(fps);
}

/** The 0.2% slack matches resolutions_share_aspect(). */
export function shareAspect(a: Resolution, b: Resolution): boolean {
  if (Math.min(a.width, a.height, b.width, b.height) <= 0) return false;
  const lhs = a.width * b.height;
  const rhs = b.width * a.height;
  return Math.abs(lhs - rhs) <= Math.max(lhs, rhs) * 0.002;
}

const SHORT_EDGES = [2160, 1440, 1080, 720];

/**
 * Standard sizes at the canvas aspect, so a vertical or ultra-wide project is
 * offered something that fits it rather than a fixed 16:9 list.
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
      width: Math.round((width * scale) / 2) * 2,
      height: Math.round((height * scale) / 2) * 2,
    });
    if (!candidate) continue;
    // Rounding an unusual aspect to even numbers can drift off it.
    if (!shareAspect(viewport, candidate)) continue;
    const key = `${candidate.width}x${candidate.height}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

export const FPS_PRESETS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 120, 144];

export function formatFps(fps: number): string {
  return String(round3(fps));
}

export const resolutionValue = (r: Resolution): string => `${r.width}x${r.height}`;

export function resolutionFromValue(value: string): Resolution | null {
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(value.trim().toLowerCase().replace('×', 'x'));
  if (!match) return null;
  return normalizeResolution({width: Number(match[1]), height: Number(match[2])});
}

/** What project_fps() settles on with no override: the highest source rate. */
export function sourceFps(clips: Pick<Clip, 'fps'>[]): number {
  const rates = clips.map(c => Number(c.fps) || 0).filter(f => f >= MIN_FPS && f <= MAX_FPS);
  return rates.length ? round3(Math.max(...rates)) : 60;
}

export function sourceGames(clips: Pick<Clip, 'game'>[]): string[] {
  const names = new Set<string>();
  clips.forEach(c => c.game && names.add(c.game));
  return [...names].sort((a, b) => a.localeCompare(b, undefined, {sensitivity: 'base'}));
}

export const MULTIPLE_GAMES = 'Multiple games';

/** Matches the daemon's own classification, so a guess and an inference agree. */
export function inferExportGame(clips: Pick<Clip, 'game'>[]): string {
  const games = sourceGames(clips);
  if (games.length === 0) return '';
  return games.length === 1 ? games[0] : MULTIPLE_GAMES;
}
