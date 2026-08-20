import {IS_SOFTWARE_RENDER} from './env';
import {t} from './i18n';

/**
 * How much motion and depth the window can afford to draw.
 *
 * Chromium can fall back to software compositing without reporting it: no
 * error, no black window, every frame simply drawn on the CPU. The one signal
 * that survives every fallback path is how fast frames actually arrive, so
 * 'auto' measures it. `?sw=1` (vice-app relaunched itself into software mode)
 * is the same verdict reached before the first paint.
 *
 * The constants below are load-bearing and were tuned against real hardware.
 * 42ms clears a 30 Hz panel's 33ms, so a slow display is never mistaken for a
 * slow compositor, and sits well under what software compositing produces.
 */
const SLOW_FRAME_MS = 42;
const PROBE_SAMPLES = 48;
const PROBE_WARMUP = 4;

export const EFFECTS_MODES = ['auto', 'full', 'reduced'] as const;
export type EffectsMode = (typeof EFFECTS_MODES)[number];

export function isEffectsMode(value: unknown): value is EffectsMode {
  return typeof value === 'string' && (EFFECTS_MODES as readonly string[]).includes(value);
}

let measured: 'full' | 'reduced' | null = null;
let probing = false;
const listeners = new Set<() => void>();

export function subscribeEffects(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function effectsReduced(mode: EffectsMode): boolean {
  if (mode === 'reduced') return true;
  if (mode === 'full') return false;
  return IS_SOFTWARE_RENDER || measured === 'reduced';
}

/** What the Appearance section says under the picker. Empty unless on auto. */
export function effectsNote(mode: EffectsMode): string {
  if (mode !== 'auto') return '';
  if (IS_SOFTWARE_RENDER) return t('settings.effectsSoftware');
  if (measured === 'reduced') return t('settings.effectsSlow');
  if (measured === 'full') return t('settings.effectsKeepingUp');
  return t('settings.effectsMeasuring');
}

export function applyEffects(mode: EffectsMode): void {
  document.documentElement.classList.toggle('perf-low', effectsReduced(mode));
  if (mode === 'auto' && measured === null) probeEffects();
}

/**
 * Sample how fast frames actually reach the screen. Chromium drives
 * requestAnimationFrame from the compositor's frame production, so a
 * compositor stuck at 15fps reports itself here directly. The median absorbs
 * the outliers a hidden window, a garbage collection or a clip decode would
 * otherwise contribute.
 */
function probeEffects(): void {
  if (probing || IS_SOFTWARE_RENDER) return;
  probing = true;
  // Always measure the expensive treatment. Probing while .perf-low is on
  // would measure the cheap one, conclude the machine is fast and turn
  // everything back on, which is how a mode that flips every launch is built.
  document.documentElement.classList.remove('perf-low');

  const gaps: number[] = [];
  let prev = 0;
  let warmup = PROBE_WARMUP;

  const step = (now: number) => {
    if (warmup > 0) {
      warmup--;
      prev = now;
      requestAnimationFrame(step);
      return;
    }
    if (prev) gaps.push(now - prev);
    prev = now;
    if (gaps.length < PROBE_SAMPLES) {
      requestAnimationFrame(step);
      return;
    }
    gaps.sort((a, b) => a - b);
    const median = gaps[gaps.length >> 1];
    measured = median > SLOW_FRAME_MS ? 'reduced' : 'full';
    probing = false;
    console.debug(`compositor probe: median frame ${median.toFixed(1)}ms, effects ${measured}`);
    listeners.forEach(fn => fn());
  };

  requestAnimationFrame(step);
}
