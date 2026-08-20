import type {Clip} from './types';

/**
 * All Clips grouping and filtering. Persisted through app-state rather than
 * localStorage, which the native window does not reliably keep across a
 * restart.
 */

export type GroupBy = 'none' | 'date' | 'game';
export type TypeFilter = 'all' | 'raw' | 'edited';

export const GROUP_BY_VALUES: GroupBy[] = ['none', 'date', 'game'];
export const TYPE_FILTER_VALUES: TypeFilter[] = ['all', 'raw', 'edited'];

export const GROUP_BY_LABELS: [GroupBy, string][] = [
  ['none', 'clips.groupNone'],
  ['date', 'clips.groupDate'],
  ['game', 'clips.groupGame'],
];

export const TYPE_FILTER_LABELS: [TypeFilter, string][] = [
  ['all', 'clips.typeAll'],
  ['raw', 'clips.typeRaw'],
  ['edited', 'clips.typeEdited'],
];

/** Written by the pre-React fork. Read once, then removed. */
export const LEGACY_GROUP_KEY = 'vice-clip-group-by';

export function normalizeGroupBy(raw: unknown): GroupBy | null {
  // "time" was this setting's first name; honour it rather than resetting.
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
  /** A game name, which is data and never translated. */
  label: string;
  /** Set instead of `label` when the heading is UI copy. */
  labelKey?: string;
  clips: Clip[];
}

const DAY = 86_400_000;

function dateBucket(raw: string, now: number): {order: number; labelKey: string} {
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return {order: 5, labelKey: 'clips.dateUnknown'};

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  if (ms >= startOfToday.getTime()) return {order: 0, labelKey: 'clips.dateToday'};

  const age = now - ms;
  if (age < 7 * DAY) return {order: 1, labelKey: 'clips.datePastWeek'};
  if (age < 30 * DAY) return {order: 2, labelKey: 'clips.datePastMonth'};
  if (age < 365 * DAY) return {order: 3, labelKey: 'clips.datePastYear'};
  return {order: 4, labelKey: 'clips.dateOlder'};
}

/** Input order is preserved inside each group, so the caller's sort holds. */
export function groupClips(clips: Clip[], groupBy: GroupBy, now = Date.now()): ClipGroup[] {
  if (groupBy === 'none') return [{key: 'all', label: '', clips}];

  if (groupBy === 'date') {
    const buckets = new Map<number, ClipGroup>();
    clips.forEach(clip => {
      const {order, labelKey} = dateBucket(clip.created_at, now);
      const bucket = buckets.get(order) ?? {key: String(order), label: '', labelKey, clips: []};
      bucket.clips.push(clip);
      buckets.set(order, bucket);
    });
    return [...buckets.entries()].sort(([a], [b]) => a - b).map(([, group]) => group);
  }

  const buckets = new Map<string, ClipGroup>();
  clips.forEach(clip => {
    const key = clip.game ?? '';
    const bucket = buckets.get(key) ??
      (clip.game
        ? {key, label: clip.game, clips: []}
        : {key: 'untagged', label: '', labelKey: 'clips.untagged', clips: []});
    bucket.clips.push(clip);
    buckets.set(key, bucket);
  });
  return [...buckets.values()].sort((a, b) => {
    // Untagged is a catch-all rather than a name, so it is pinned last. Keying
    // off the bucket, not its text, so a game actually called "Untagged" sorts
    // as the name it is.
    if (a.key === 'untagged') return 1;
    if (b.key === 'untagged') return -1;
    return a.label.localeCompare(b.label, undefined, {sensitivity: 'base'});
  });
}
