import {defineTheme} from '@astryxdesign/core/theme';

import {neutralTheme} from '../../src/themes/neutral/neutralTheme';
import {ACCENTS, type AccentName} from './accents';

// Chunky geometry, in the manner of Android's expressive quick settings: a
// control is an object you could pick up, not a rectangle with the corners
// taken off. Radius scales with the element rather than staying constant, so a
// small control reads as nearly circular while a panel stays a soft rectangle.
const RADIUS = {
  '--radius-inner': '0.75rem',     // 12px, M3 medium: inputs, small controls
  '--radius-element': '1.25rem',   // 20px, M3 large-increased: buttons, nav
  '--radius-container': '1.75rem', // 28px, M3 extra-large: cards and tiles
  '--radius-page': '2.25rem',      // 36px, the app frame
} as const;

// A spring with real overshoot. Expressed as a cubic-bezier rather than a
// linear() spring so it degrades identically on the WebKit2GTK fallback path
// that some users land on.
const EASE_SPRING = 'cubic-bezier(.34, 1.56, .64, 1)';

/**
 * Everything shared across the five accents: geometry and motion. Split out so
 * a radius change is one edit rather than five.
 */
const viceBase = defineTheme({
  name: 'vice-base',
  extends: neutralTheme,
  motion: {fast: 140, medium: 320, slow: 700, ratio: 0.75, easing: EASE_SPRING},
  tokens: {...RADIUS},
});

// Vice's accent is user state, not a brand constant: five swatches in Settings,
// default blue, persisted per install. Astryx's rule is never to override
// --color-* in :root, so each swatch is its own theme and <Theme> swaps them at
// runtime.
//
// Neutral's own accent is deliberately monochrome (#ebebeb on dark) with dark
// on-accent text. Substituting a coloured accent at the same tonal position
// keeps that contrast relationship intact, which is why on-accent text stays
// #171717 rather than flipping to white.
function accentTheme(name: AccentName) {
  const a = ACCENTS[name];
  return defineTheme({
    name: `vice-${name}`,
    extends: viceBase,
    tokens: {
      // The neutral theme's palette is replaced wholesale by this accent's M3
      // scheme. Doing it here rather than in the stylesheets means every rule
      // that already reads a --color-* token picks up the tonal value without
      // being touched, and the ones that need a specific role reach for the
      // --vice-* properties below.
      //
      // Dark-only app, but both slots are filled so a light render never falls
      // back to neutral's grayscale.
      '--color-accent': [a.base, a.base],
      '--color-text-accent': [a.base, a.base],
      '--color-icon-accent': [a.base, a.base],
      '--color-on-accent': [a.onBase, a.onBase],

      '--color-background-body': [a.bg, a.bg],
      '--color-background-surface': [a.surfaceLow, a.surfaceLow],
      '--color-background-popover': [a.surfaceHigh, a.surfaceHigh],

      '--color-text-primary': [a.onSurface, a.onSurface],
      '--color-text-secondary': [a.onSurfaceVariant, a.onSurfaceVariant],
      // M3 states disabled content as on-surface at 38%. Left unmapped this
      // stayed the neutral theme's #525252, a flat gray that disappeared the
      // moment anything behind it gained a tone.
      '--color-text-disabled': [
        `color-mix(in srgb, ${a.onSurface} 38%, transparent)`,
        `color-mix(in srgb, ${a.onSurface} 38%, transparent)`,
      ],

      // outline-variant is for dividers and hairlines; outline is for
      // boundaries that have to hold 3:1, like a field border. M3 is explicit
      // that these are not interchangeable.
      '--color-border': [a.outlineVariant, a.outlineVariant],

      '--color-error': [a.error, a.error],
      '--color-on-error': [a.onError, a.onError],

      // The neutral theme defines this as #262626, the same value its raised
      // surface uses, so every hover built on it repainted an element in the
      // colour it already had. It is the tonal rung now.
      '--color-accent-muted': [a.secondaryContainer, a.secondaryContainer],

      // Neutral hardcodes its own blue (#0074e2) into the focus and selection
      // rings. Left alone, a purple install would still focus blue.
      '--shadow-inset-hover': `inset 0px 0px 0px 2px ${a.base}4D`,
      '--shadow-inset-selected': `inset 0px 0px 0px 2px ${a.base}80`,
    },
    components: {
      statusdot: {'variant:accent': {backgroundColor: a.base}},
      progressbar: {'variant:accent': {'--color-accent': a.base}},
      button: {
        'variant:primary': {backgroundColor: a.base, color: a.onBase},
      },
      link: {base: {color: a.base}},
    },
  });
}

/**
 * The M3 roles our own CSS addresses by name, plus the few values that are not
 * part of any token set. Set as inline custom properties on the app root rather
 * than smuggled through defineTheme, so they stay visible and typed.
 *
 * Pair a container with its own on-colour. Putting --color-text-primary on a
 * filled tonal button is the mistake this naming exists to make obvious.
 */
export function accentVars(name: AccentName): Record<string, string> {
  const a = ACCENTS[name];
  return {
    '--vice-accent-hover': a.hover,
    '--vice-accent-active': a.active,
    '--vice-ambient': a.ambient,
    '--vice-bg': a.bg,

    '--vice-surface-lowest': a.surfaceLowest,
    '--vice-surface-low': a.surfaceLow,
    '--vice-surface': a.surface,
    '--vice-surface-high': a.surfaceHigh,
    '--vice-surface-highest': a.surfaceHighest,

    '--vice-secondary-container': a.secondaryContainer,
    '--vice-on-secondary-container': a.onSecondaryContainer,
    '--vice-primary-container': a.primaryContainer,
    '--vice-on-primary-container': a.onPrimaryContainer,
    '--vice-tertiary-container': a.tertiaryContainer,
    '--vice-on-tertiary-container': a.onTertiaryContainer,

    '--vice-outline': a.outline,
    '--vice-outline-variant': a.outlineVariant,

    '--vice-error-container': a.errorContainer,
    '--vice-on-error-container': a.onErrorContainer,

    '--vice-ease-spring': EASE_SPRING,
  };
}

export const VICE_THEMES = {
  blue: accentTheme('blue'),
  purple: accentTheme('purple'),
  green: accentTheme('green'),
  red: accentTheme('red'),
  orange: accentTheme('orange'),
} satisfies Record<AccentName, ReturnType<typeof accentTheme>>;
