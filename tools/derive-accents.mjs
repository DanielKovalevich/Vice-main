// Derives Vice's five accent schemes and writes ui-src/theme/accents.ts.
//
// Run with: npm run accents
//
// Every colour in the UI comes from here. Each of the five swatches is a real
// Material 3 dark scheme built from that swatch as the seed, so cards, inactive
// buttons and the page background are tonal roles rather than values anybody
// picked. Before this the surfaces were a hand-rolled OKLCH ramp at chroma
// 0.024, which is gray with a rumour of hue, and an inactive control wore a
// surface role instead of a container one. That is the whole reason the buttons
// looked unfinished.

import {readFileSync, writeFileSync} from 'node:fs';

// material-color-utilities 0.4.0 exports only its barrel, and the barrel pulls
// in scheme/*.js, which use extensionless relative imports that Node's ESM
// resolver rejects. Locate the package through the entry its exports map does
// allow, then import the clean submodules as siblings. tools/mcu-resolve.mjs
// handles the same bug for the package's own internal imports.
const entry = import.meta.resolve('@material/material-color-utilities');
const at = p => new URL(p, entry).href;

const {Hct} = await import(at('./hct/hct.js'));
const {TonalPalette} = await import(at('./palettes/tonal_palette.js'));
const {DynamicScheme} = await import(at('./dynamiccolor/dynamic_scheme.js'));
const {Variant} = await import(at('./dynamiccolor/variant.js'));
const {MaterialDynamicColors: M} = await import(
  at('./dynamiccolor/material_dynamic_colors.js')
);
const {argbFromHex, hexFromArgb} = await import(at('./utils/string_utils.js'));

// The accents Vice has shipped since 2.0. These are seeds now, not values: the
// hue is what survives into the scheme, the lightness and chroma do not.
const SOURCE = {
  blue: '#0099ff',
  purple: '#8b5cf6',
  green: '#10b981',
  red: '#ef4444',
  orange: '#f97316',
};

// Expressive's palette chromas, read out of
// node_modules/@material/material-color-utilities/dynamiccolor/dynamic_scheme.js
// at version 0.4.0. Re-check them after any bump: they are not exported.
const CHROMA = {primary: 40, secondary: 24, tertiary: 32, neutral: 8, neutralVariant: 12};
const NEUTRAL_HUE_SHIFT = 15;
const TERTIARY_HUE_SHIFT = 60;

// 'tied' keeps every palette on the accent's own hue. 'detached' uses
// Expressive's own rotations, which the library documents as "intentionally
// detached from the source color".
//
// Vice ships tied, for two reasons. Andrew asked for "a second, paler accent
// colour", and a rotated secondary is not a second version of the accent, it is
// a different colour. More concretely, Expressive's rotation table maps blue
// (hue 254) and purple (hue 300) onto almost the same secondary: #5f3c52 and
// #5f3c51. Two of the five swatches would have had matching buttons.
const STRATEGY = process.env.VICE_ACCENT_STRATEGY ?? 'tied';

// M3's dark primary is tone 80, which is right for four of the five. Blue is
// gamut-clipped there: at hue 254 sRGB cannot hold the chroma, so asking for
// 40, 48, 64 or 80 all return the identical #9fcaff at a realized 37. Chroma
// cannot fix it and the result reads pale next to the others. Dropping the
// tone frees the chroma back up (40.1 at 78 and below) and darkens it, which
// is what "less pale" actually needs. Measured, not guessed.
const PRIMARY_TONE = {blue: 74};
const DEFAULT_PRIMARY_TONE = 80;

function scheme(hex) {
  const src = Hct.fromInt(argbFromHex(hex));
  const h = src.hue;
  const common = {
    sourceColorHct: src,
    variant: Variant.EXPRESSIVE,
    contrastLevel: 0,
    isDark: true,
    // The 2025 spec resolves surfaceContainerLowest to #000000, and Vice's
    // ambient wash needs somewhere to land, so the background is never allowed
    // to reach pure black. 2021 also keeps a genuinely coloured secondary
    // container, which is the rung this whole change exists to add.
    specVersion: '2021',
  };
  if (STRATEGY === 'detached') {
    // Expressive derives primary from sourceHue + 240, which turns the blue
    // swatch green. The swatches are labelled by colour name in Settings, so
    // primary is pinned to the seed's hue even in this mode.
    return new DynamicScheme({
      ...common,
      primaryPalette: TonalPalette.fromHueAndChroma(h, CHROMA.primary),
    });
  }
  return new DynamicScheme({
    ...common,
    primaryPalette: TonalPalette.fromHueAndChroma(h, CHROMA.primary),
    secondaryPalette: TonalPalette.fromHueAndChroma(h, CHROMA.secondary),
    tertiaryPalette: TonalPalette.fromHueAndChroma(
      (h + TERTIARY_HUE_SHIFT) % 360,
      CHROMA.tertiary,
    ),
    neutralPalette: TonalPalette.fromHueAndChroma(
      (h + NEUTRAL_HUE_SHIFT) % 360,
      CHROMA.neutral,
    ),
    neutralVariantPalette: TonalPalette.fromHueAndChroma(
      (h + NEUTRAL_HUE_SHIFT) % 360,
      CHROMA.neutralVariant,
    ),
  });
}

const srgbToLinear = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const hexToRgb = hex => [0, 2, 4].map(i => parseInt(hex.slice(1 + i, 3 + i), 16) / 255);
const luminance = hex => {
  const [R, G, B] = hexToRgb(hex).map(srgbToLinear);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
};
const contrast = (a, b) => {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

const rows = Object.entries(SOURCE).map(([name, source]) => {
  const s = scheme(source);
  const g = role => hexFromArgb(role.getArgb(s));
  const palette = (p, t) => hexFromArgb(s[p].tone(t));
  const tone = PRIMARY_TONE[name] ?? DEFAULT_PRIMARY_TONE;

  return {
    name,
    source,
    // base and bg keep these names because two other files depend on them:
    // BootThemeTests regexes them out of accents.ts, and index.html carries its
    // own copy for the pre-paint cover.
    base: palette('primaryPalette', tone),
    onBase: g(M.onPrimary),
    // M3 expresses hover and press as state layers over the fill. Vice paints
    // solid colours because several of these sit under a CSS transition, so the
    // ends of the ramp come off the palette directly, either side of the base.
    hover: palette('primaryPalette', Math.min(tone + 6, 100)),
    active: palette('primaryPalette', Math.max(tone - 6, 0)),
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
    // The ambient wash behind everything. Never carries text.
    ambient: palette('primaryPalette', 22),
  };
});

// M3 guarantees contrast for correctly paired roles, so this is not the spec's
// job, it is a guard against Vice pairing them wrongly. It has caught two real
// regressions and stays.
const PAIRS = [
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
];
// Body text has to clear AA. onSurfaceVariant is the dimmer partner used for
// meta lines, held to the same bar because it is still body text.
const DIM_PAIRS = [
  ['bg', 'onSurfaceVariant'],
  ['surfaceLow', 'onSurfaceVariant'],
  ['surface', 'onSurfaceVariant'],
];

const failures = [];
for (const r of rows) {
  for (const [fill, text] of [...PAIRS, ...DIM_PAIRS]) {
    const ratio = contrast(r[fill], r[text]);
    if (ratio < 4.5) failures.push(`${r.name}: ${text} on ${fill} is ${ratio.toFixed(2)}`);
  }
  // The accent has to stay legible as text on every surface it labels.
  for (const fill of ['bg', 'surfaceLow', 'surface']) {
    const ratio = contrast(r[fill], r.base);
    if (ratio < 4.5) failures.push(`${r.name}: accent text on ${fill} is ${ratio.toFixed(2)}`);
  }
  // Andrew's rule: the background is never pure black, so the ambient wash at
  // the top has somewhere to land.
  for (const key of ['bg', 'surfaceLowest']) {
    if (r[key] === '#000000') failures.push(`${r.name}: ${key} is pure black`);
  }
}

if (failures.length) {
  console.error('Scheme failed its own checks:');
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

for (const r of rows) {
  const hue = h => String(Math.round(Hct.fromInt(argbFromHex(h)).hue)).padStart(3);
  console.log(
    `${r.name.padEnd(7)} ${r.source} -> ${r.base} (hue ${hue(r.base)})\n` +
    `        bg ${r.bg}  card ${r.surfaceLow}  ` +
    `button ${r.secondaryContainer} (hue ${hue(r.secondaryContainer)}) on ${r.onSecondaryContainer}  ` +
    `chip ${r.primaryContainer}`,
  );
}

const KEYS = [
  'base', 'onBase', 'hover', 'active', 'bg',
  'surfaceLowest', 'surfaceLow', 'surface', 'surfaceHigh', 'surfaceHighest',
  'onSurface', 'onSurfaceVariant',
  'primaryContainer', 'onPrimaryContainer',
  'secondaryContainer', 'onSecondaryContainer',
  'tertiaryContainer', 'onTertiaryContainer',
  'outline', 'outlineVariant',
  'error', 'onError', 'errorContainer', 'onErrorContainer',
  'ambient',
];

const body = rows
  .map(r => `  ${r.name}: {\n${KEYS.map(k => `    ${k}: '${r[k]}',`).join('\n')}\n  },`)
  .join('\n');

writeFileSync(
  new URL('../ui-src/theme/accents.ts', import.meta.url),
  `// Generated by tools/derive-accents.mjs. Do not edit by hand.
//
// Each accent is a Material 3 dark scheme seeded from the colour Vice has
// shipped since 2.0, built with Expressive's palette chromas. The seed
// contributes its hue and nothing else: tones come from the scheme, so a card
// and an inactive button are tonal roles rather than picked values.
//
// Pair a fill with its own on-colour and nothing else. The generator checks
// every pair below at WCAG AA and refuses to write this file if one fails.

export type AccentName = ${Object.keys(SOURCE).map(n => `'${n}'`).join(' | ')};

export interface AccentRamp {
  /** M3 primary. Filled buttons, active toggles, the record dot. */
  base: string;
  /** Text and icons on \`base\`. Never use --color-text-* on a filled button. */
  onBase: string;
  hover: string;
  active: string;
  /** M3 surface. The page. */
  bg: string;
  /** Recessed controls: a select at rest, a switch that is off. */
  surfaceLowest: string;
  /** Content containers: clip cards, settings cards, panels. */
  surfaceLow: string;
  /** The sidebar and other navigation surfaces. */
  surface: string;
  surfaceHigh: string;
  surfaceHighest: string;
  onSurface: string;
  /** Dimmer body text: meta lines, secondary labels. */
  onSurfaceVariant: string;
  /** The deeper tonal rung, same hue as the accent: playlist chips. */
  primaryContainer: string;
  onPrimaryContainer: string;
  /** The tonal rung: an inactive button, a quiet control. */
  secondaryContainer: string;
  onSecondaryContainer: string;
  /** A contrasting accent. Available, currently unused: at accent+60 it lands
   * far enough away to read as a different theme leaking in. */
  tertiaryContainer: string;
  onTertiaryContainer: string;
  /** Interactive boundaries. */
  outline: string;
  /** Dividers and hairlines. */
  outlineVariant: string;
  error: string;
  onError: string;
  errorContainer: string;
  onErrorContainer: string;
  /** Drives the ambient wash. Never carries text. */
  ambient: string;
}

export const ACCENTS: Record<AccentName, AccentRamp> = {
${body}
};

export const DEFAULT_ACCENT: AccentName = 'blue';

export const ACCENT_NAMES = Object.keys(ACCENTS) as AccentName[];
`,
);

// The boot cover paints before the bundle parses, so index.html carries its own
// copy of the background and accent for all five. Writing it from here means it
// cannot drift; BootThemeTests still fails the build if somebody hand-edits it.
const indexPath = new URL('../vice/ui/index.html', import.meta.url);
const map = (key) =>
  '{' + rows.map(r => `${r.name}:'${r[key]}'`).join(',') + '}';

let index = readFileSync(indexPath, 'utf8');
for (const [name, key] of [['BG', 'bg'], ['AC', 'base']]) {
  const pattern = new RegExp(`var ${name} = \\{[^}]*\\};`);
  // Test before replacing: an unchanged run writes identical bytes, so
  // comparing the result to the original cannot tell "already correct" from
  // "pattern missing".
  if (!pattern.test(index)) {
    console.error(`Could not find the ${name} map in vice/ui/index.html.`);
    process.exit(1);
  }
  index = index.replace(pattern, `var ${name} = ${map(key)};`);
}
writeFileSync(indexPath, index);

console.log(`\nWrote ui-src/theme/accents.ts and the boot map in vice/ui/index.html (strategy: ${STRATEGY})`);
