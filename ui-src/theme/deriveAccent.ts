// The barrel, not the submodules: the package's exports map allows only ".",
// so a deep import does not resolve. tools/derive-accents.mjs reaches past it
// with an explicit URL because Node rejects the barrel; a bundler has the
// opposite problem, and this is the side that works here.
import {
  DynamicScheme,
  Hct,
  MaterialDynamicColors as M,
  TonalPalette,
  Variant,
  argbFromHex,
  hexFromArgb,
} from '@material/material-color-utilities';

import type {AccentRamp} from './accents';

/**
 * The same derivation tools/derive-accents.mjs runs at build time, in the
 * browser, for a colour the user picked.
 *
 * This file and the generator have to agree, or a custom accent would be a
 * different design system to the five shipped ones. `npm run accents:verify`
 * derives all five shipped seeds through this code and diffs the result
 * against the generated accents.ts, role by role. It is wired into the Python
 * suite as well, so drift fails the build rather than shipping quietly.
 *
 * Everything the generator's comments warn about applies here. In particular:
 * never construct SchemeExpressive directly, because it derives primary from
 * sourceHue + 240 and would turn a blue seed green. Every palette is passed
 * explicitly on the seed's own hue.
 */

// Expressive's palette chromas, read out of the installed package at 0.4.0.
// Re-check after any bump: they are not exported.
const CHROMA = {primary: 40, secondary: 24, tertiary: 32, neutral: 8, neutralVariant: 12};
const NEUTRAL_HUE_SHIFT = 15;
const TERTIARY_HUE_SHIFT = 60;

/**
 * M3's dark primary.
 *
 * Uniform, deliberately. sRGB clips the requested chroma at this tone for most
 * hues (measured at chroma 40: red realizes 29.9, orange 31.1, purple 36.7,
 * blue 37, green 39.9), and the generator ships tone 80 for four of the five
 * anyway. Only blue is hand-lowered, to 74, because Andrew judged it read pale
 * beside the others: a judgement about one hue, not a rule. Reproducing that
 * as a heuristic darkened four accents that were never meant to move, so a
 * custom colour lands where the four unmodified accents land and nowhere else.
 */
const DEFAULT_PRIMARY_TONE = 80;

function schemeFor(hct: Hct): DynamicScheme {
  const h = hct.hue;
  return new DynamicScheme({
    sourceColorHct: hct,
    variant: Variant.EXPRESSIVE,
    contrastLevel: 0,
    isDark: true,
    // 2021, not 2025: the newer spec resolves surfaceContainerLowest to pure
    // black, and Vice's ambient wash needs somewhere to land.
    specVersion: '2021',
    primaryPalette: TonalPalette.fromHueAndChroma(h, CHROMA.primary),
    secondaryPalette: TonalPalette.fromHueAndChroma(h, CHROMA.secondary),
    tertiaryPalette: TonalPalette.fromHueAndChroma(
      (h + TERTIARY_HUE_SHIFT) % 360,
      CHROMA.tertiary,
    ),
    neutralPalette: TonalPalette.fromHueAndChroma((h + NEUTRAL_HUE_SHIFT) % 360, CHROMA.neutral),
    neutralVariantPalette: TonalPalette.fromHueAndChroma(
      (h + NEUTRAL_HUE_SHIFT) % 360,
      CHROMA.neutralVariant,
    ),
  });
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex: string) => {
  const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(1 + i, 3 + i), 16) / 255);
  const [R, G, B] = [r, g, b].map(srgbToLinear);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
};

export function contrastRatio(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

/** Exactly the generator's pairs, so both refuse the same schemes. */
const PAIRS: [keyof AccentRamp, keyof AccentRamp][] = [
  ['base', 'onBase'],
  ['primaryContainer', 'onPrimaryContainer'],
  ['secondaryContainer', 'onSecondaryContainer'],
  ['tertiaryContainer', 'onTertiaryContainer'],
  ['errorContainer', 'onErrorContainer'],
  ['bg', 'onSurface'],
  ['surfaceLow', 'onSurface'],
  ['surface', 'onSurface'],
  ['surfaceHigh', 'onSurface'],
  ['surfaceLowest', 'onSurface'],
  ['bg', 'onSurfaceVariant'],
  ['surfaceLow', 'onSurfaceVariant'],
  ['surface', 'onSurfaceVariant'],
];

/** Everything the generator refuses to write a scheme for. */
export function rampFailures(ramp: AccentRamp): string[] {
  const out: string[] = [];
  for (const [fill, text] of PAIRS) {
    const ratio = contrastRatio(ramp[fill], ramp[text]);
    if (ratio < 4.5) out.push(`${text} on ${fill} is ${ratio.toFixed(2)}`);
  }
  // The accent has to stay legible as text on every surface it labels.
  for (const fill of ['bg', 'surfaceLow', 'surface'] as const) {
    const ratio = contrastRatio(ramp[fill], ramp.base);
    if (ratio < 4.5) out.push(`accent text on ${fill} is ${ratio.toFixed(2)}`);
  }
  // Andrew's rule: the background is never pure black, so the ambient wash has
  // somewhere to land.
  for (const key of ['bg', 'surfaceLowest'] as const) {
    if (ramp[key] === '#000000') out.push(`${key} is pure black`);
  }
  return out;
}

function build(hct: Hct, tone: number): AccentRamp {
  const s = schemeFor(hct);
  const g = (role: {getArgb: (scheme: DynamicScheme) => number}) => hexFromArgb(role.getArgb(s));
  const p = (t: number) => hexFromArgb(s.primaryPalette.tone(t));

  return {
    base: p(tone),
    onBase: g(M.onPrimary),
    // M3 expresses hover and press as state layers. Vice paints solid colours
    // because several of these sit under a CSS transition, so the ends of the
    // ramp come off the palette either side of the base.
    hover: p(Math.min(tone + 6, 100)),
    active: p(Math.max(tone - 6, 0)),
    bg: g(M.surface),
    surfaceLowest: g(M.surfaceContainerLowest),
    surfaceLow: g(M.surfaceContainerLow),
    surface: g(M.surfaceContainer),
    surfaceHigh: g(M.surfaceContainerHigh),
    surfaceHighest: g(M.surfaceContainerHighest),
    onSurface: g(M.onSurface),
    onSurfaceVariant: g(M.onSurfaceVariant),
    primaryContainer: g(M.primaryContainer),
    onPrimaryContainer: g(M.onPrimaryContainer),
    secondaryContainer: g(M.secondaryContainer),
    onSecondaryContainer: g(M.onSecondaryContainer),
    tertiaryContainer: g(M.tertiaryContainer),
    onTertiaryContainer: g(M.onTertiaryContainer),
    outline: g(M.outline),
    outlineVariant: g(M.outlineVariant),
    error: g(M.error),
    onError: g(M.onError),
    errorContainer: g(M.errorContainer),
    onErrorContainer: g(M.onErrorContainer),
    ambient: p(22),
  };
}

/**
 * A full Material 3 ramp from one seed colour.
 *
 * Only the hue survives: the tones come from the scheme, exactly as they do
 * for the five shipped accents, so a custom theme is the same design system
 * rather than a colour pasted over it.
 *
 * When the scheme its own checks would reject, primary is lifted a step at a
 * time until it reads. A user who picks a dark navy gets a lighter accent
 * rather than an unreadable window, which is the same answer the generator
 * gives by hand for blue.
 */
export function deriveAccent(
  seed: string,
  /** Only the generator passes this, to reproduce blue's hand-picked 74. */
  toneOverride?: number,
): {ramp: AccentRamp; failures: string[]} {
  const hct = Hct.fromInt(argbFromHex(seed));
  const start = toneOverride ?? DEFAULT_PRIMARY_TONE;

  let ramp = build(hct, start);
  let failures = rampFailures(ramp);
  for (let tone = start + 2; failures.length && tone <= 92; tone += 2) {
    const lifted = build(hct, tone);
    const liftedFailures = rampFailures(lifted);
    if (liftedFailures.length < failures.length) {
      ramp = lifted;
      failures = liftedFailures;
    }
  }
  return {ramp, failures};
}

/** Six hex digits with a leading hash, which is all any caller here accepts. */
export function normalizeHex(value: string): string | null {
  const text = value.trim().replace(/^#/, '');
  const full = text.length === 3 ? text.replace(/./g, c => c + c) : text;
  return /^[0-9a-fA-F]{6}$/.test(full) ? `#${full.toLowerCase()}` : null;
}
