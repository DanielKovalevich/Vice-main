/**
 * Shapes the daemon actually sends. Verified against a running ShareServer
 * rather than inferred, because several of them are not what you would guess:
 * list endpoints are wrapped in an envelope, timestamps are ISO strings, and
 * `name` still carries the file extension.
 */

export interface Clip {
  slug: string;
  /** Stable identity from the clip library. Null for rows not yet catalogued. */
  uuid: string | null;
  /** The filename, extension included. Use clipTitle() for display. */
  name: string;
  size: number;
  created_at: string;
  game: string | null;
  /** Raw recordings versus editor exports. Drives the All Clips type filter. */
  origin: ClipOrigin;
  views: number;
  duration: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  vcodec: string | null;
  /** Set when ffprobe could not read the file. The clip is left on disk. */
  unreadable: boolean;
  unreadable_reason: string;
  share_url: string;
  share_is_public: boolean;
  /** Already carries a content revision, so it can be used as a cache key. */
  video_url: string;
  thumb_url: string;
  /** Only ever set on edited clips. */
  provenance: ClipProvenance | null;
  /** Null until the clip has been published, or attempted, at least once. */
  fireshare: ClipFireShare | null;
}

/** Raw recording or editor export. */
export type ClipOrigin = 'raw' | 'edited';

/** Which clips an edited clip was built from. */
export interface ClipProvenance {
  sources: {slug: string; game: string | null}[];
  game: string | null;
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
  /**
   * The game-aware replay buffer is up but deliberately not capturing, because
   * no supported game is running. Distinct from `recording: false` caused by a
   * broken recorder, which sets recorder_error instead.
   */
  waiting_for_game?: boolean;
  /** The supported game currently detected, when the indicator is enabled. */
  game?: string | null;
}

/* ── FireShare ──────────────────────────────────────────────────────────── */

/**
 * Tri-state, matching vice.config.FIRESHARE_PRIVACY_VALUES. It maps to the
 * nullable bool the FireShare API wants: server_default omits `private`
 * entirely rather than guessing, which is the whole point of the third state.
 */
export type FireSharePrivacy = 'server_default' | 'public' | 'private';

export const fireSharePrivacyToBool = (value: FireSharePrivacy): boolean | null =>
  value === 'public' ? false : value === 'private' ? true : null;

export const fireSharePrivacyFromBool = (value: boolean | null | undefined): FireSharePrivacy =>
  value === true ? 'private' : value === false ? 'public' : 'server_default';

export type FireShareState =
  | 'idle'
  | 'uploading'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'stale'
  | 'canceled';

export interface FireShareAttempt {
  attempt_id: string;
  state: FireShareState;
  public_url: string;
  progress_pct: number;
  /** What the user asked for. Null means they left it at the server default. */
  requested_private: boolean | null;
  /** What FireShare actually applied. */
  effective_private: boolean | null;
  error_code: string;
  error_message: string;
  folder: string;
}

export interface ClipFireShare {
  current: FireShareAttempt | null;
  last_ready: FireShareAttempt | null;
}

/**
 * The payload every fireshare_publish_* message carries.
 *
 * `seq` is server-side ordering and must be honoured: progress arrives many
 * times a second and out of order under load, so an event whose seq is not
 * newer than the one already held has to be dropped, or the bar walks
 * backwards. Events for a different attempt_id are dropped outright.
 */
export interface FireSharePublishEvent {
  slug: string;
  attempt_id: string;
  seq: number;
  state?: FireShareState;
  progress_pct?: number;
  public_url?: string;
  error_code?: string;
  error_message?: string;
  requested_private?: boolean | null;
  effective_private?: boolean | null;
}

export interface FireShareConfigStatus {
  configured: boolean;
  token_configured: boolean;
  base_url: string;
  default_privacy: FireSharePrivacy;
  default_folder: string;
  default_title_template: string;
  require_https: boolean;
}

export interface FireShareStatus {
  configured: boolean;
  token_configured: boolean;
  active: FireShareAttempt[];
}

/* ── YouTube ────────────────────────────────────────────────────────────── */

export type YouTubePrivacy = 'private' | 'unlisted' | 'public';

export interface YouTubeConnector {
  id: string;
  name: string;
  secrets_path: string | null;
  cache_path: string | null;
  oauth_port: number;
  title_template: string;
  description: string;
  privacy: YouTubePrivacy;
  tags: string[];
  playlist_ids: string[];
  notify: boolean;
}

/** Runtime readiness, separate from the stored connector config. */
export interface YouTubeConnectorStatus {
  id: string;
  available: boolean;
  executable: string;
  error?: string;
}

export type YouTubeUploadState = 'uploading' | 'done' | 'partial' | 'error';

export interface YouTubeUploadJob {
  slug: string;
  job_id: string;
  title: string;
  status: YouTubeUploadState;
  url?: string;
  error?: string;
  /** Set when the video landed but a post-upload step (playlist add) did not. */
  warning?: string;
  partial?: boolean;
  canceled?: boolean;
  connector_id?: string;
  connector_name?: string;
  started_at?: string;
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
  notifications: Record<string, unknown>;
  ui: Record<string, unknown>;
  fireshare: Record<string, unknown>;
  youtube: Record<string, unknown>;
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
  /** The game-aware buffer's view of what is running. */
  | {type: 'game_status'; game?: string | null; waiting_for_game?: boolean}
  | ({type: 'fireshare_publish_started'} & FireSharePublishEvent)
  | ({type: 'fireshare_publish_progress'} & FireSharePublishEvent)
  | ({type: 'fireshare_publish_processing'} & FireSharePublishEvent)
  | ({type: 'fireshare_publish_ready'} & FireSharePublishEvent)
  | ({type: 'fireshare_publish_failed'} & FireSharePublishEvent)
  | ({type: 'fireshare_publish_stale'} & FireSharePublishEvent)
  | ({type: 'youtube_upload_started'} & YouTubeUploadJob)
  | ({type: 'youtube_upload_done'} & YouTubeUploadJob)
  | ({type: 'youtube_upload_error'} & YouTubeUploadJob);

/** Every fireshare_publish_* type, for narrowing a message to a publish event. */
export const FIRESHARE_WS_TYPES = [
  'fireshare_publish_started',
  'fireshare_publish_progress',
  'fireshare_publish_processing',
  'fireshare_publish_ready',
  'fireshare_publish_failed',
  'fireshare_publish_stale',
] as const;

export const isFireSharePublishMessage = (
  msg: WsMessage,
): msg is WsMessage & FireSharePublishEvent & {type: (typeof FIRESHARE_WS_TYPES)[number]} =>
  (FIRESHARE_WS_TYPES as readonly string[]).includes(msg.type);

export type ViewName = 'home' | 'clips' | 'editor' | 'settings' | 'about';

/** The filename without its extension, which is what every screen shows. */
export function clipTitle(clip: Clip): string {
  return clip.name.replace(/\.(mp4|mkv|mov|webm)$/i, '');
}
