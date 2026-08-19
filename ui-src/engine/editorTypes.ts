import type {Clip} from '../lib/types';

export interface EdTrack {
  id: string;
  type: 'video' | 'audio' | 'text';
  label: string;
}

export interface EdTransition {
  fx: string;
  len: number;
}

export interface EdItem {
  id: string;
  kind: 'clip' | 'audio' | 'text';
  trackId: string;
  start: number;
  dur: number;
  clipId?: string;
  offset?: number;
  muted?: boolean;
  /**
   * Linear audio gain, 0 to 2. Absent means unity. The daemon validates the
   * same range and bakes it into the export.
   */
  gain?: number;
  trans?: EdTransition;
  text?: string;
  font?: string;
  size?: number;
  weight?: number;
  color?: string;
  x?: number;
  y?: number;
}

export interface EdProject {
  version: number;
  tracks: EdTrack[];
  items: EdItem[];
  /**
   * Canvas size. The daemon derives one from the sources when it is absent,
   * so it stays optional here rather than being invented client-side.
   */
  viewport?: {width: number; height: number};
  /** Export size. Must share the viewport's aspect; the daemon enforces it. */
  export?: {width: number; height: number};
  /** Frame rate override. Absent means "follow the sources". */
  fps?: number;
}

export type EdTab = 'library' | 'effects' | 'text';

/** Editor library filters, matching the All Clips ones. */
export type EdLibType = 'all' | 'raw' | 'edited';

/** What the React chrome renders from. Recomputed on every engine change. */
export interface EdSnapshot {
  ready: boolean;
  tab: EdTab;
  query: string;
  playing: boolean;
  playhead: number;
  duration: number;
  pps: number;
  selected: EdItem | null;
  canSplit: boolean;
  canDetach: boolean;
  canDuplicate: boolean;
  canDelete: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** Set while the daemon is transcoding an H.265 proxy for a clip on stage. */
  preparing: boolean;
  empty: boolean;
  /** Library filters, and the games available to filter by. */
  libGame: string;
  libType: EdLibType;
  libGames: string[];
}

export interface EditorDeps {
  clips: () => Clip[];
  notify: (title: string, tone?: 'accent' | 'error') => void;
  accent: () => string;
}
