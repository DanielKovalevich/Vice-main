/**
 * The keyboard overlay's layout, the same one vice/keys.py draws on screen.
 * Rows of [key id, label, width in key units]; a null id is a gap.
 */
export const KEY_LAYOUT: Array<Array<[string | null, string, number]>> = [
  [[null, '', 0.5], ['1', '1', 1], ['2', '2', 1], ['3', '3', 1], ['4', '4', 1], ['5', '5', 1]],
  [['TAB', 'Tab', 1.5], ['Q', 'Q', 1], ['W', 'W', 1], ['E', 'E', 1], ['R', 'R', 1]],
  [['SHIFT', 'Shift', 1.5], ['A', 'A', 1], ['S', 'S', 1], ['D', 'D', 1], ['F', 'F', 1]],
  [['CTRL', 'Ctrl', 1.5], ['SPACE', '', 4]],
];

export type KeyInterval = [number, number, string];

/** Keys held at `time`, from intervals sorted by start. */
export function keysAt(intervals: KeyInterval[], time: number): Set<string> {
  const held = new Set<string>();
  for (const [from, to, key] of intervals) {
    if (from > time) break;
    if (time < to) held.add(key);
  }
  return held;
}
