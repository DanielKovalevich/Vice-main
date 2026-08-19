import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from 'react';

import {api} from '../lib/api';
import {connectWs} from '../lib/ws';
import {formatDuration, hotkeyLabel} from '../lib/format';
import {H264_SUPPORTED} from '../lib/env';
import {ACCENT_NAMES, DEFAULT_ACCENT, type AccentName} from '../theme/accents';
import {clipTitle} from '../lib/types';
import type {Clip, Config, Playlist, Status, UpdateInfo, ViewName, WsMessage} from '../lib/types';

/**
 * What the status island is showing. `ambient` is the standing state of the
 * recorder; `event` is a transient that takes over for a few seconds and then
 * hands back. Keeping them separate is what lets a clip-saved notice appear
 * without losing track of the fact that a session is still running.
 */
export type IslandTone = 'neutral' | 'accent' | 'live' | 'error';

export interface IslandEvent {
  id: number;
  kind: 'saving' | 'saved' | 'error' | 'info';
  title: string;
  detail?: string;
  tone: IslandTone;
  /** How long it holds the island before the ambient state returns. */
  holdMs: number;
}

export type BannerId = 'recorder' | 'cpu' | 'codec-gpu' | 'codec-h264';

interface State {
  ready: boolean;
  loadError: string | null;
  config: Config | null;
  clips: Clip[];
  playlists: Playlist[];
  status: Status;
  tunnelUrl: string | null;
  update: UpdateInfo | null;
  /** Slugs that arrived this session, for the "new" treatment in the grid. */
  recentNew: string[];
  view: ViewName;
  currentPlaylistId: string | null;
  searchQuery: string;
  accent: AccentName;
  event: IslandEvent | null;
  sessionStartedAt: number | null;
  dismissed: BannerId[];
  /** Bumped whenever the editor should reload its project from the daemon. */
  editorProjectRevision: number;
}

const INITIAL_STATUS: Status = {
  running: false,
  version: '',
  clips: 0,
  local_url: '',
  public_url: null,
  base_url: '',
  public_is_tunnel: false,
  recording: false,
  backend: 'auto',
  session_active: false,
  hotkeys_available: true,
  ready: true,
  recorder_error: null,
  cpu_fallback: false,
  codec_fallback: false,
};

const initialState: State = {
  ready: false,
  loadError: null,
  config: null,
  clips: [],
  playlists: [],
  status: INITIAL_STATUS,
  tunnelUrl: null,
  update: null,
  recentNew: [],
  view: 'home',
  currentPlaylistId: null,
  searchQuery: '',
  accent: DEFAULT_ACCENT,
  event: null,
  sessionStartedAt: null,
  dismissed: [],
  editorProjectRevision: 0,
};

type Action =
  | {type: 'loaded'; config: Config; clips: Clip[]; playlists: Playlist[]; status: Status}
  | {type: 'loadFailed'; error: string}
  | {type: 'ws'; msg: WsMessage}
  | {type: 'setView'; view: ViewName; playlistId?: string | null}
  | {type: 'setSearch'; query: string}
  | {type: 'setAccent'; accent: AccentName}
  | {type: 'setConfig'; config: Config}
  | {type: 'mergeConfig'; patch: Record<string, Record<string, unknown>>}
  | {type: 'setClips'; clips: Clip[]}
  | {type: 'setPlaylists'; playlists: Playlist[]}
  | {type: 'event'; event: Omit<IslandEvent, 'id'>}
  | {type: 'clearEvent'; id: number}
  | {type: 'dismiss'; banner: BannerId}
  | {type: 'clearUpdate'};

let eventSeq = 0;

function withEvent(state: State, event: Omit<IslandEvent, 'id'>): State {
  return {...state, event: {...event, id: ++eventSeq}};
}

function reduce(state: State, action: Action): State {
  switch (action.type) {
    case 'loaded':
      return {
        ...state,
        ready: true,
        loadError: null,
        config: action.config,
        clips: action.clips,
        playlists: action.playlists,
        status: action.status,
        tunnelUrl: action.status.public_url ?? null,
        update: action.status.update ?? null,
        sessionStartedAt: action.status.session_active ? Date.now() : null,
      };

    case 'loadFailed':
      // Still mark ready: a window stuck on the boot cover cannot tell anyone
      // what went wrong, which is the failure mode #156 was about.
      return {...state, ready: true, loadError: action.error};

    case 'setView':
      return {
        ...state,
        view: action.view,
        currentPlaylistId:
          action.playlistId !== undefined ? action.playlistId : action.view === 'clips' ? state.currentPlaylistId : null,
      };

    case 'setSearch':
      return {...state, searchQuery: action.query};

    case 'setAccent':
      return {...state, accent: action.accent};

    case 'setConfig':
      return {...state, config: action.config};

    case 'mergeConfig': {
      if (!state.config) return state;
      const config = {...state.config} as unknown as Record<string, Record<string, unknown>>;
      for (const [section, values] of Object.entries(action.patch)) {
        config[section] = {...(config[section] ?? {}), ...values};
      }
      return {...state, config: config as unknown as Config};
    }

    case 'setClips':
      return {...state, clips: action.clips};

    case 'setPlaylists':
      return {...state, playlists: action.playlists};

    case 'event':
      return withEvent(state, action.event);

    case 'clearEvent':
      return state.event?.id === action.id ? {...state, event: null} : state;

    case 'dismiss':
      return state.dismissed.includes(action.banner)
        ? state
        : {...state, dismissed: [...state.dismissed, action.banner]};

    case 'clearUpdate':
      return {...state, update: null};

    case 'ws':
      return reduceWs(state, action.msg);

    default:
      return state;
  }
}

function reduceWs(state: State, msg: WsMessage): State {
  switch (msg.type) {
    case 'clip_saved': {
      const existing = state.clips.some(c => c.slug === msg.clip.slug);
      const clips = existing
        ? state.clips.map(c => (c.slug === msg.clip.slug ? {...c, ...msg.clip} : c))
        : [msg.clip, ...state.clips];
      const next = {
        ...state,
        clips,
        recentNew: existing ? state.recentNew : [...state.recentNew, msg.clip.slug],
      };
      // An update to a clip already on screen is not news; a new one is.
      return existing
        ? next
        : withEvent(next, {
            kind: 'saved',
            title: 'Clip saved',
            detail: [clipTitle(msg.clip), msg.clip.game].filter(Boolean).join(' · '),
            tone: 'accent',
            holdMs: 4000,
          });
    }

    case 'clip_deleted':
      return {
        ...state,
        clips: state.clips.filter(c => c.slug !== msg.slug),
        recentNew: state.recentNew.filter(s => s !== msg.slug),
      };

    case 'playlists_changed':
      return {...state, playlists: msg.playlists ?? []};

    case 'clip_saving':
      return withEvent(state, {
        kind: 'saving',
        title: 'Saving clip',
        tone: 'neutral',
        // Long buffers on slow disks take a while, and clip_saved supersedes
        // this anyway, so it is allowed to sit there.
        holdMs: 30000,
      });

    case 'clip_error':
      return withEvent(state, {
        kind: 'error',
        title: 'Could not save the clip',
        detail: msg.error || 'The recorder did not say why',
        tone: 'error',
        holdMs: 9000,
      });

    case 'status': {
      const {type: _ignored, ...partial} = msg;
      // Merge first, then read. A status broadcast may carry only the fields
      // that changed, and deciding from the partial would stop the session
      // clock every time one arrived without session_active in it.
      const merged = {...state.status, ...partial};
      return {
        ...state,
        status: merged,
        sessionStartedAt: merged.session_active ? state.sessionStartedAt ?? Date.now() : null,
        update: partial.update ?? state.update,
      };
    }

    case 'tunnel_url':
      return withEvent(
        {...state, tunnelUrl: msg.url},
        {kind: 'info', title: 'Public link ready', detail: msg.url, tone: 'accent', holdMs: 6000},
      );

    case 'tunnel_error':
      return withEvent(
        {...state, tunnelUrl: null},
        {
          kind: 'error',
          title: 'No public link',
          detail: msg.error || 'The share tunnel is unavailable',
          tone: 'error',
          holdMs: 9000,
        },
      );

    case 'session_start':
      return withEvent(
        {
          ...state,
          status: {...state.status, recording: true, session_active: true},
          sessionStartedAt: Date.now(),
        },
        {
          kind: 'info',
          title: 'Session recording',
          detail: 'Double-tap the clip key to stop',
          tone: 'live',
          holdMs: 5000,
        },
      );

    case 'session_stop':
      return withEvent(
        {...state, status: {...state.status, session_active: false}, sessionStartedAt: null},
        {kind: 'saved', title: 'Session saved', tone: 'accent', holdMs: 4000},
      );

    case 'session_highlight':
      return withEvent(state, {
        kind: 'info',
        title: 'Highlight marked',
        detail: typeof msg.time === 'number' ? formatDuration(msg.time) : undefined,
        tone: 'accent',
        holdMs: 3000,
      });

    case 'update_available': {
      const {type: _ignored, ...info} = msg;
      return {...state, update: info};
    }

    case 'editor_project_changed':
      return {...state, editorProjectRevision: state.editorProjectRevision + 1};

    // Export progress belongs to the editor, which subscribes separately.
    case 'export_progress':
    case 'export_done':
    case 'export_error':
      return state;

    default:
      return state;
  }
}

interface Store {
  state: State;
  dispatch: React.Dispatch<Action>;
  /** Clips filtered by the sidebar search and the open playlist. */
  visibleClips: Clip[];
  hotkey: string;
  refreshClips: () => Promise<void>;
  refreshPlaylists: () => Promise<void>;
  notify: (event: Omit<IslandEvent, 'id'>) => void;
  saveConfig: (
    patch: Record<string, Record<string, unknown>>,
  ) => Promise<{applied?: boolean; warning?: string; restart_required?: boolean}>;
}

const StoreContext = createContext<Store | null>(null);

export function StoreProvider({children}: {children: ReactNode}) {
  const [state, dispatch] = useReducer(reduce, initialState);

  // First load. Everything the shell needs before it can show a screen.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [config, clips, playlists, status] = await Promise.all([
          api.getConfig(),
          api.clips(),
          api.playlists(),
          api.status(),
        ]);
        if (!cancelled) dispatch({type: 'loaded', config, clips, playlists, status});
      } catch (err) {
        if (!cancelled) dispatch({type: 'loadFailed', error: (err as Error).message});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The accent is a per-install preference, not a synced setting.
  useEffect(() => {
    const saved = localStorage.getItem('vice-theme');
    if (saved && (ACCENT_NAMES as string[]).includes(saved)) {
      dispatch({type: 'setAccent', accent: saved as AccentName});
    }
  }, []);

  useEffect(() => connectWs(msg => dispatch({type: 'ws', msg})), []);

  // Transient island events expire on their own.
  useEffect(() => {
    if (!state.event) return;
    const {id, holdMs} = state.event;
    const timer = window.setTimeout(() => dispatch({type: 'clearEvent', id}), holdMs);
    return () => window.clearTimeout(timer);
  }, [state.event]);

  // Say it once, on the machines where it is true: clips will never play here.
  useEffect(() => {
    if (state.ready && !H264_SUPPORTED) {
      dispatch({
        type: 'event',
        event: {
          kind: 'error',
          title: 'Clips cannot play in this window',
          detail: 'This Qt WebEngine build has no H.264 decoder',
          tone: 'error',
          holdMs: 10000,
        },
      });
    }
  }, [state.ready]);

  const refreshClips = useCallback(async () => {
    dispatch({type: 'setClips', clips: await api.clips()});
  }, []);

  const refreshPlaylists = useCallback(async () => {
    dispatch({type: 'setPlaylists', playlists: await api.playlists()});
  }, []);

  const notify = useCallback((event: Omit<IslandEvent, 'id'>) => {
    dispatch({type: 'event', event});
  }, []);

  /**
   * Persist a partial config and merge it locally.
   *
   * The daemon answers with a result rather than the new config, so the patch
   * we sent is what gets merged, matching what the old UI did. Throws on
   * failure so callers can revert their own control.
   */
  const saveConfig = useCallback(
    async (patch: Record<string, Record<string, unknown>>) => {
      const result = await api.saveConfig(patch);
      if (result.ok === false) throw new Error(result.error || 'The change was not saved');
      dispatch({type: 'mergeConfig', patch});
      return result;
    },
    [],
  );

  const visibleClips = useMemo(() => {
    const query = state.searchQuery.trim().toLowerCase();
    const playlist = state.currentPlaylistId
      ? state.playlists.find(p => p.id === state.currentPlaylistId)
      : null;
    let list = state.clips;
    if (playlist) {
      const members = new Set(playlist.clip_slugs ?? []);
      list = list.filter(c => members.has(c.slug));
    }
    if (query) {
      list = list.filter(
        c => c.name.toLowerCase().includes(query) || (c.game ?? '').toLowerCase().includes(query),
      );
    }
    return list;
  }, [state.clips, state.playlists, state.currentPlaylistId, state.searchQuery]);

  const hotkey = useMemo(
    () => hotkeyLabel(state.config?.hotkeys?.clip as string | undefined),
    [state.config],
  );

  const value = useMemo<Store>(
    () => ({
      state,
      dispatch,
      visibleClips,
      hotkey,
      refreshClips,
      refreshPlaylists,
      notify,
      saveConfig,
    }),
    [state, visibleClips, hotkey, refreshClips, refreshPlaylists, notify, saveConfig],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore was called outside the provider');
  return store;
}
