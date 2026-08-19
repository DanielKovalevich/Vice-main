import type {Clip} from './types';

/**
 * All Clips grouping and filtering.
 *
 * Both live server-side in /api/app-state rather than localStorage, because
 * the native window's localStorage does not survive a restart on every
 * QtWebEngine build. An older fork build did use localStorage, so the key it
 * wrote is migrated once and then cleared.
 */

export type GroupBy = 'none' | 'date' | 'game';
export type TypeFilter = 'all' | 'raw' | 'edited';

export const GROUP_BY_VALUES: GroupBy[] = ['none', 'date', 'game'];
export const TYPE_FILTER_VALUES: TypeFilter[] = ['all', 'raw', 'edited'];

export const GROUP_BY_LABELS: [GroupBy, string][] = [
  ['none', 'Group by: None'],
  ['date', 'Group by: Date'],
  ['game', 'Group by: Game'],
];

export const TYPE_FILTER_LABELS: [TypeFilter, string][] = [
  ['all', 'Type: All'],
  ['raw', 'Type: Raw'],
  ['edited', 'Type: Edited'],
];

/** The key the pre-React fork build wrote. Read once, then removed. */
export const LEGACY_GROUP_KEY = 'vice-clip-group-by';

export function normalizeGroupBy(raw: unknown): GroupBy | null {
  // "time" was this setting's first name; treat it as "date" rather than
  // silently resetting someone's choice.
  const value = raw === 'time' ? 'date' : raw;
  return GROUP_BY_VALUES.includes(value as GroupBy) ? (value as GroupBy) : null;
}

export function normalizeTypeFilter(raw: unknown): TypeFilter | null {
  return TYPE_FILTER_VALUES.includes(raw as TypeFilter) ? (raw as TypeFilter) : null;
}

export const clipType = (clip: Clip): 'raw' | 'edited' =>
  clip.origin === 'edited' ? 'edited' : 'raw';

export function filterByType(clips: Clip[], filter: TypeFilter): Clip[] {
  return filter === 'all' ? clips : clips.filter(clip => clipType(clip) === filter);
}

export interface ClipGroup {
  key: string;
  label: string;
  clips: Clip[];
}

const DAY = 86_400_000;

/** Buckets in the order they should appear, coarsening as they age. */
function dateBucket(raw: string, now: number): {order: number; label: string} {
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return {order: 5, label: 'Unknown date'};

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  if (ms >= startOfToday.getTime()) return {order: 0, label: 'Today'};

  const age = now - ms;
  if (age < 7 * DAY) return {order: 1, label: 'Past week'};
  if (age < 30 * DAY) return {order: 2, label: 'Past month'};
  if (age < 365 * DAY) return {order: 3, label: 'Past year'};
  return {order: 4, label: 'Older'};
}

/**
 * Group clips for display. The input order is preserved inside each group, so
 * whatever sort the caller applied still holds.
 */
export function groupClips(clips: Clip[], groupBy: GroupBy, now = Date.now()): ClipGroup[] {
  if (groupBy === 'none') return [{key: 'all', label: '', clips}];

  if (groupBy === 'date') {
    const buckets = new Map<number, ClipGroup>();
    clips.forEach(clip => {
      const {order, label} = dateBucket(clip.created_at, now);
      const bucket = buckets.get(order) ?? {key: String(order), label, clips: []};
      bucket.clips.push(clip);
      buckets.set(order, bucket);
    });
    return [...buckets.entries()].sort(([a], [b]) => a - b).map(([, group]) => group);
  }

  // By game. Untagged sorts last however it collates, because it is a
  // catch-all rather than a name.
  const buckets = new Map<string, ClipGroup>();
  clips.forEach(clip => {
    const key = clip.game ?? '';
    const bucket = buckets.get(key) ?? {key: key || 'untagged', label: clip.game ?? 'Untagged', clips: []};
    bucket.clips.push(clip);
    buckets.set(key, bucket);
  });
  return [...buckets.values()].sort((a, b) => {
    if (a.label === 'Untagged') return 1;
    if (b.label === 'Untagged') return -1;
    return a.label.localeCompare(b.label, undefined, {sensitivity: 'base'});
  });
}
