/**
 * The eight marker colours, in one place.
 *
 * Highlights cycle through them as they are added, and the pen in the image
 * viewer draws with them. Deliberately not theme tokens: a mark sits on top of
 * whatever frame it lands on, so it has to stay the colour it was drawn in when
 * the accent changes underneath it.
 */
export const MARK_COLORS = [
  '#f59e0b',
  '#ef4444',
  '#22c55e',
  '#3b82f6',
  '#ec4899',
  '#8b5cf6',
  '#06b6d4',
  '#f97316',
];

export const DEFAULT_MARK_COLOR = MARK_COLORS[0];
