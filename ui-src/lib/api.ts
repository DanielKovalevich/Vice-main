import type {Clip, Config, Highlight, Playlist, Status} from './types';

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
  deleteClip: (slug: string) => request<void>(`/api/clips/${slug}`, {method: 'DELETE'}),
  renameClip: (slug: string, name: string) => post<Clip>(`/api/clips/${slug}/rename`, {name}),
  revealClip: (slug: string) => post<void>(`/api/clips/${slug}/reveal`),
  openClip: (slug: string) => post<void>(`/api/clips/${slug}/open`),
  copyClipFile: (slug: string) => post<void>(`/api/clips/${slug}/copy-file`),
  trimClip: (slug: string, start: number, end: number) =>
    post<Clip>(`/api/clips/${slug}/trim`, {start, end}),
  markViewed: (slug: string) => post<{ok?: boolean; views: number}>(`/api/clips/${slug}/view`),

  highlights: async (slug: string) =>
    (await request<{highlights: Highlight[]}>(`/api/clips/${slug}/highlights`)).highlights ?? [],
  addHighlight: (slug: string, body: Omit<Highlight, 'id'>) =>
    post<{ok?: boolean; error?: string; highlight: Highlight}>(
      `/api/clips/${slug}/highlights`,
      body,
    ),
  updateHighlight: (slug: string, id: string, body: Partial<Omit<Highlight, 'id'>>) =>
    request<{ok?: boolean; error?: string}>(`/api/clips/${slug}/highlights/${id}`, {
      method: 'PATCH',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    }),
  deleteHighlight: (slug: string, id: string) =>
    request<void>(`/api/clips/${slug}/highlights/${id}`, {method: 'DELETE'}),

  triggerClip: () => post<void>('/api/trigger'),

  playlists: async () => (await request<{playlists: Playlist[]}>('/api/playlists')).playlists,
  createPlaylist: (body: unknown) =>
    post<{ok?: boolean; error?: string; playlist: Playlist}>('/api/playlists', body),
  /** Edits are a PATCH; only create and membership are POSTs. */
  updatePlaylist: (id: string, body: unknown) =>
    request<{ok?: boolean; error?: string; playlist: Playlist}>(`/api/playlists/${id}`, {
      method: 'PATCH',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    }),
  deletePlaylist: (id: string) => request<void>(`/api/playlists/${id}`, {method: 'DELETE'}),
  addClipToPlaylist: (id: string, slug: string) =>
    post<{ok?: boolean; error?: string}>(`/api/playlists/${id}/clips`, {slug}),
  removeClipFromPlaylist: (id: string, slug: string) =>
    request<{ok?: boolean; error?: string}>(`/api/playlists/${id}/clips/${slug}`, {
      method: 'DELETE',
    }),

  displays: (backend?: string) =>
    request<{backend: string; displays: unknown[]; warning: string | null}>(
      `/api/displays${backend ? `?backend=${encodeURIComponent(backend)}` : ''}`,
    ),
  audioSources: () => request<{sources: unknown[]; warning: string | null}>('/api/audio-sources'),

  editorProject: () => request<unknown>('/api/editor/project'),
  saveEditorProject: (project: unknown) => post<unknown>('/api/editor/project', project),
  startExport: (body: unknown) => post<{job_id: string}>('/api/editor/export', body),
  cancelExport: (jobId: string) => post<void>(`/api/editor/export/${jobId}/cancel`),

  checkUpdate: () => post<unknown>('/api/update/check'),
};
