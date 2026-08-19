/**
 * Shapes the daemon actually sends. Verified against a running ShareServer
 * rather than inferred, because several of them are not what you would guess:
 * list endpoints are wrapped in an envelope, timestamps are ISO strings, and
 * `name` still carries the file extension.
 */

export interface Clip {
  slug: string;
  /** The filename, extension included. Use clipTitle() for display. */
  name: string;
  size: number;
  created_at: string;
  game: string | null;
  views: number;
  duration: number | null;
  width: number | null;
  height: number | null;
  vcodec: string | null;
  /** Set when ffprobe could not read the file. The clip is left on disk. */
  unreadable: boolean;
  unreadable_reason: string;
  share_url: string;
  share_is_public: boolean;
  /** Already carries a content revision, so it can be used as a cache key. */
  video_url: string;
  thumb_url: string;
}

/** A marked timestamp inside one clip. The id is a string of digits. */
export interface Highlight {
  id: string;
  time: number;
  label: string;
  color: string;
}

export interface Playlist {
  id: string;
  kind: 'auto' | 'custom' | string;
  name: string;
  game: string | null;
  emoji: string | null;
  color1: string | null;
  color2: string | null;
  clip_slugs: string[];
  created_at: string;
  edited: boolean;
}

export interface Status {
  running: boolean;
  version: string;
  /** A count, not the clips themselves. */
  clips: number;
  local_url: string;
  public_url: string | null;
  base_url: string;
  public_is_tunnel: boolean;
  recording: boolean;
  backend: string;
  session_active: boolean;
  hotkeys_available: boolean;
  /** False while the recorder is down, paired with recorder_error (#156). */
  ready: boolean;
  recorder_error: string | null;
  cpu_fallback: boolean;
  codec_fallback: boolean;
  update?: UpdateInfo | null;
}

export interface UpdateInfo {
  version: string;
  url?: string;
  /** Summarised release-note lines, one per bullet. */
  notes?: string[];
  /**
   * How this machine should update, worked out by the daemon: "aur",
   * "script" or "unknown". The command is empty for unknown.
   */
  install?: {method?: string; command?: string};
}

export interface Config {
  recording: Record<string, unknown> & {
    buffer_duration: number;
    clip_duration: number;
    fps: number;
  };
  hotkeys: Record<string, unknown> & {clip: string; clip_presets: unknown[]};
  output: Record<string, unknown> & {directory: string};
  sharing: Record<string, unknown> & {port: number; cloudflare_tunnel: boolean};
  discord: Record<string, unknown> & {enabled: boolean};
  updates: Record<string, unknown>;
  notifications: Record<string, unknown>;
  ui: Record<string, unknown>;
}

/** Every message the daemon broadcasts. */
export type WsMessage =
  | {type: 'clip_saved'; clip: Clip}
  | {type: 'clip_deleted'; slug: string}
  | {type: 'playlists_changed'; playlists: Playlist[]}
  | {type: 'clip_saving'}
  | {type: 'clip_error'; error?: string}
  | ({type: 'status'} & Partial<Status>)
  | {type: 'tunnel_url'; url: string}
  | {type: 'tunnel_error'; error?: string}
  | {type: 'session_start'}
  | {type: 'session_stop'}
  | {type: 'session_highlight'; time?: number}
  | {type: 'export_progress'; [key: string]: unknown}
  | {type: 'export_done'; [key: string]: unknown}
  | {type: 'export_error'; [key: string]: unknown}
  | {type: 'editor_project_changed'}
  | ({type: 'update_available'} & UpdateInfo);

export type ViewName = 'home' | 'clips' | 'editor' | 'settings' | 'about';

/** The filename without its extension, which is what every screen shows. */
export function clipTitle(clip: Clip): string {
  return clip.name.replace(/\.(mp4|mkv|mov|webm)$/i, '');
}
