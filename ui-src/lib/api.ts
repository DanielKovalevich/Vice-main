import type {
  Clip,
  ClipFireShare,
  ClipOrigin,
  Config,
  FireShareAttempt,
  FireShareConfigStatus,
  FireShareStatus,
  Highlight,
  Playlist,
  Status,
  YouTubeConnectorStatus,
  YouTubePrivacy,
  YouTubeUploadJob,
} from './types';

/**
 * The daemon's local HTTP API. Every call is same-origin: the public server
 * never exposes any of this.
 */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? {'Content-Type': 'application/json', ...init?.headers} : init?.headers,
  });
  if (!res.ok) {
    // Prefer the daemon's own explanation. It is usually the useful one.
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as {error?: string};
      if (body.error) detail = body.error;
    } catch {
      // Not JSON. The status line stands on its own.
    }
    throw new Error(detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, {method: 'POST', body: body === undefined ? undefined : JSON.stringify(body)});

/**
 * A clip slug is a filename, so it can hold `#`, `?`, `%` or `+`, each of which
 * means something else in a URL. Encode every path segment that carries one
 * (#138); the daemon builds `video_url` and `thumb_url` already encoded.
 */
const enc = (segment: string) => encodeURIComponent(segment);

export const api = {
  status: () => request<Status>('/api/status'),

  getConfig: () => request<Config>('/api/config'),
  /**
   * Returns a result, not the config: `applied` is false when the change was
   * stored but could not take effect on the running recorder, and
   * `restart_required` means the daemon needs a restart for it to land.
   */
  saveConfig: (partial: Record<string, unknown>) =>
    post<{
      ok?: boolean;
      error?: string;
      applied?: boolean;
      warning?: string;
      restart_required?: boolean;
    }>('/api/config', partial),

  /** Small cross-session UI flags. Server-side because native localStorage is unreliable. */
  getAppState: () => request<Record<string, unknown>>('/api/app-state'),
  setAppState: (partial: Record<string, unknown>) =>
    post<Record<string, unknown>>('/api/app-state', partial),

  // The list endpoints wrap their payload in an envelope. Unwrapped here so
  // callers only ever see the list.
  clips: async () => (await request<{clips: Clip[]}>('/api/clips')).clips,
  deleteClip: (slug: string) => request<void>(`/api/clips/${enc(slug)}`, {method: 'DELETE'}),
  renameClip: (slug: string, name: string) => post<Clip>(`/api/clips/${enc(slug)}/rename`, {name}),
  revealClip: (slug: string) => post<void>(`/api/clips/${enc(slug)}/reveal`),
  openClip: (slug: string) => post<void>(`/api/clips/${enc(slug)}/open`),
  copyClipFile: (slug: string) => post<void>(`/api/clips/${enc(slug)}/copy-file`),
  trimClip: (slug: string, start: number, end: number) =>
    post<Clip>(`/api/clips/${enc(slug)}/trim`, {start, end}),
  markViewed: (slug: string) => post<{ok?: boolean; views: number}>(`/api/clips/${enc(slug)}/view`),

  highlights: async (slug: string) =>
    (await request<{highlights: Highlight[]}>(`/api/clips/${enc(slug)}/highlights`)).highlights ?? [],
  addHighlight: (slug: string, body: Omit<Highlight, 'id'>) =>
    post<{ok?: boolean; error?: string; highlight: Highlight}>(
      `/api/clips/${enc(slug)}/highlights`,
      body,
    ),
  updateHighlight: (slug: string, id: string, body: Partial<Omit<Highlight, 'id'>>) =>
    request<{ok?: boolean; error?: string}>(`/api/clips/${enc(slug)}/highlights/${enc(id)}`, {
      method: 'PATCH',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    }),
  deleteHighlight: (slug: string, id: string) =>
    request<void>(`/api/clips/${enc(slug)}/highlights/${enc(id)}`, {method: 'DELETE'}),

  triggerClip: () => post<void>('/api/trigger'),

  playlists: async () => (await request<{playlists: Playlist[]}>('/api/playlists')).playlists,
  createPlaylist: (body: unknown) =>
    post<{ok?: boolean; error?: string; playlist: Playlist}>('/api/playlists', body),
  /** Edits are a PATCH; only create and membership are POSTs. */
  updatePlaylist: (id: string, body: unknown) =>
    request<{ok?: boolean; error?: string; playlist: Playlist}>(`/api/playlists/${enc(id)}`, {
      method: 'PATCH',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    }),
  deletePlaylist: (id: string) => request<void>(`/api/playlists/${enc(id)}`, {method: 'DELETE'}),
  addClipToPlaylist: (id: string, slug: string) =>
    post<{ok?: boolean; error?: string}>(`/api/playlists/${enc(id)}/clips`, {slug}),
  removeClipFromPlaylist: (id: string, slug: string) =>
    request<{ok?: boolean; error?: string}>(`/api/playlists/${enc(id)}/clips/${enc(slug)}`, {
      method: 'DELETE',
    }),

  displays: (backend?: string) =>
    request<{backend: string; displays: unknown[]; warning: string | null}>(
      `/api/displays${backend ? `?backend=${encodeURIComponent(backend)}` : ''}`,
    ),
  audioSources: () => request<{sources: unknown[]; warning: string | null}>('/api/audio-sources'),

  editorProject: () => request<unknown>('/api/editor/project'),
  saveEditorProject: (project: unknown) => post<unknown>('/api/editor/project', project),
  startExport: (body: unknown) =>
    post<{job_id: string; encoder?: string}>('/api/editor/export', body),
  cancelExport: (jobId: string) => post<void>(`/api/editor/export/${enc(jobId)}/cancel`),

  /**
   * Clip metadata. Returns the updated clip and the full playlist set, because
   * changing a clip's game can move it between auto playlists, so the caller
   * applies both rather than refetching twice.
   */
  setClipMetadata: (
    slug: string,
    body: {game: string | null; origin: ClipOrigin; playlist_ids: string[]},
  ) =>
    post<{ok?: boolean; error?: string; clip: Clip; playlists: Playlist[]}>(
      `/api/clips/${enc(slug)}/metadata`,
      body,
    ),

  /* ── FireShare ──────────────────────────────────────────────────────── */

  fireshareStatus: () => request<FireShareStatus>('/api/fireshare/status'),
  /** Settings-facing view: the stored config plus whether a token is held. */
  fireshareConfigStatus: () => request<FireShareConfigStatus>('/api/fireshare/config-status'),
  fireshareFolders: () =>
    request<{
      ok?: boolean;
      error?: string;
      error_code?: string;
      default_folder?: string;
      folders?: string[];
    }>('/api/fireshare/folders'),
  /**
   * The token is written on its own, never through /api/config, so it stays out
   * of the settings draft and out of any config dump.
   */
  setFireshareToken: (token: string) =>
    post<{ok?: boolean; error?: string; token_configured?: boolean}>('/api/fireshare/config', {
      token,
    }),
  fireshareValidate: (body: {base_url: string; token?: string}) =>
    post<{ok?: boolean; error?: string; error_code?: string}>('/api/fireshare/validate', body),

  clipFireshare: (slug: string) =>
    request<{ok?: boolean; clip: string; fireshare: ClipFireShare | null}>(
      `/api/clips/${enc(slug)}/fireshare`,
    ),
  /** `private: null` means "let FireShare apply its own default". */
  publishToFireshare: (
    slug: string,
    body: {title: string; folder: string; private: boolean | null},
  ) =>
    post<{ok?: boolean; error?: string; error_code?: string; attempt: FireShareAttempt}>(
      `/api/clips/${enc(slug)}/fireshare/publish`,
      body,
    ),
  retryFireshare: (attemptId: string) =>
    post<{ok?: boolean; error?: string; attempt: FireShareAttempt}>(
      `/api/fireshare/attempts/${enc(attemptId)}/retry`,
    ),
  /**
   * `cancelled: false` is not an error: the upload beat the cancel to a
   * terminal state. Surface it as a notice, not a failure.
   */
  cancelFireshare: (attemptId: string) =>
    post<{ok?: boolean; error?: string; cancelled: boolean; attempt?: FireShareAttempt}>(
      `/api/fireshare/attempts/${enc(attemptId)}/cancel`,
    ),

  /* ── YouTube ────────────────────────────────────────────────────────── */

  youtubeStatus: () =>
    request<{connectors: YouTubeConnectorStatus[]; active: YouTubeUploadJob | null}>(
      '/api/youtube/status',
    ),
  /** `active` comes back when a different upload is already running. */
  uploadToYoutube: (
    slug: string,
    body: {
      connector_id: string;
      title: string;
      description: string;
      privacy: YouTubePrivacy;
      tags: string[];
      playlist_ids: string[];
      notify: boolean;
    },
  ) =>
    post<{ok?: boolean; error?: string; job: YouTubeUploadJob; active?: YouTubeUploadJob}>(
      `/api/clips/${enc(slug)}/youtube`,
      body,
    ),
  cancelYoutubeUpload: (jobId: string) =>
    post<{ok?: boolean; error?: string}>(`/api/youtube/uploads/${enc(jobId)}/cancel`),
};
