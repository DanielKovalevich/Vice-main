import {useEffect, useId, useLayoutEffect, useMemo, useRef, useState} from 'react';

import {api} from '../lib/api';
import {useEscape} from '../lib/escape';
import {onWsMessage} from '../lib/ws';
import {
  FPS_PRESETS,
  MULTIPLE_GAMES,
  formatFps,
  inferExportGame,
  normalizeFps,
  normalizeResolution,
  presetResolutions,
  resolutionFromValue,
  resolutionValue,
  sourceFps,
  sourceGames,
} from '../lib/editorExport';
import type {Clip} from '../lib/types';
import {ACCENTS} from '../theme/accents';
import {useStore} from '../state/store';
import {createEditorEngine, type EditorEngine} from '../engine/editor';
import {ED_FONTS, ED_LIB_HINTS, ED_SWATCHES, edFmt} from '../engine/editorConstants';
import type {EdSnapshot, EdTab, EdLibType} from '../engine/editorTypes';
import {Modal} from '../components/Modal';
import {IconClose} from '../components/Icons';
import {Select, TextField, Toggle} from '../components/settings/Fields';

const TABS: Array<[EdTab, string]> = [
  ['library', 'Library'],
  ['effects', 'Effects'],
  ['text', 'Text'],
];

export function Editor() {
  const {state, notify, dispatch} = useStore();
  const {clips, accent, editorProjectRevision, config} = state;

  const stageRef = useRef<HTMLDivElement>(null);
  const stageWrapRef = useRef<HTMLDivElement>(null);
  const fadeRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const libraryRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);

  // The engine reads clips and the accent through getters, so it always sees
  // current values without being rebuilt when either changes.
  const clipsRef = useRef(clips);
  clipsRef.current = clips;
  const accentRef = useRef(accent);
  accentRef.current = accent;

  const engineRef = useRef<EditorEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = createEditorEngine({
      clips: () => clipsRef.current,
      notify: (title, tone = 'accent') =>
        notify({
          kind: tone === 'error' ? 'error' : 'info',
          title,
          tone,
          holdMs: tone === 'error' ? 6000 : 3000,
        }),
      accent: () => ACCENTS[accentRef.current].base,
    });
  }
  const engine = engineRef.current;

  const [snap, setSnap] = useState<EdSnapshot>(() => engine.snapshot());
  const [resetOpen, setResetOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  useEffect(() => engine.subscribe(setSnap), [engine]);

  useEffect(() => {
    let cancelled = false;
    void engine.load().then(() => {
      if (cancelled || !stageRef.current) return;
      engine.mount({
        stage: stageRef.current,
        stageWrap: stageWrapRef.current!,
        fadeOverlay: fadeRef.current!,
        timelineCanvas: canvasRef.current!,
        timelineScroll: scrollRef.current!,
        libraryScroll: libraryRef.current!,
      });
    });
    return () => {
      cancelled = true;
      engine.destroy();
    };
  }, [engine]);

  // The library and the missing-clip styling follow the clip list, or an
  // editor opened before the first /api/clips response stays empty forever.
  useEffect(() => {
    engine.setClips(clips);
  }, [engine, clips]);

  useEffect(() => {
    if (editorProjectRevision > 0) void engine.onProjectChanged();
  }, [engine, editorProjectRevision]);

  // Panel sizes live on the frame as custom properties, the same shape the
  // old editor used, so the CSS grid does not need to know about the drag.
  const [libWidth, setLibWidth] = useState(() =>
    Math.max(240, Math.min(324, Math.round(window.innerWidth * 0.22))),
  );
  const [timelineHeight, setTimelineHeight] = useState(300);

  const startResize = (axis: 'x' | 'y') => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // A drag still works without capture; it just leaves the element sooner.
    }
    const origin = axis === 'x' ? e.clientX : e.clientY;
    const base = axis === 'x' ? libWidth : timelineHeight;
    const move = (ev: PointerEvent) => {
      const delta = (axis === 'x' ? ev.clientX : ev.clientY) - origin;
      if (axis === 'x') setLibWidth(Math.max(232, Math.min(520, base + delta)));
      else {
        const cap = Math.round((frameRef.current?.clientHeight ?? 800) * 0.7);
        setTimelineHeight(Math.max(170, Math.min(cap, base - delta)));
      }
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  // Volume is an occasional adjustment, so it opens on demand from the
  // timeline toolbar rather than taking a standing panel beside the preview.
  const [gainAt, setGainAt] = useState<{x: number; y: number} | null>(null);
  const selected = snap.selected;
  const isText = selected?.kind === 'text';
  // Text has no audio; everything else on the timeline does.
  const hasAudio = Boolean(selected) && !isText;
  const gainPercent = Math.round((selected?.gain ?? 1) * 100);

  // Selecting something else, or nothing, closes the popover: it belongs to
  // the item it was opened for.
  useEffect(() => {
    setGainAt(null);
  }, [selected?.id]);

  return (
    <div
      className="editor"
      ref={frameRef}
      style={{
        ['--ed-lib-w' as string]: `${libWidth}px`,
        ['--ed-tl-h' as string]: `${timelineHeight}px`,
      }}>
      <div className="ed-top">
        {/* ── library panel ─────────────────────────────────────── */}
        <aside className="ed-panel ed-library">
          <div className="ed-tabs" role="tablist">
            <div className="ed-tab-glider" style={{left: `${TABS.findIndex(t => t[0] === snap.tab) * 33.333}%`}} />
            {TABS.map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                className="ed-tab"
                aria-selected={snap.tab === id}
                onClick={() => engine.setTab(id)}>
                {label}
              </button>
            ))}
          </div>

          {snap.tab === 'library' ? (
            <>
              <div className="ed-lib-search">
                <SearchGlyph />
                <input
                  value={snap.query}
                  placeholder="Search clips"
                  aria-label="Search clips"
                  spellCheck={false}
                  onChange={e => engine.search(e.target.value)}
                />
              </div>
              <div className="ed-lib-filters">
                <select
                  className="select"
                  aria-label="Filter the library by game"
                  value={snap.libGame}
                  onChange={e => engine.setLibraryFilters({game: e.target.value})}>
                  <option value="">All games</option>
                  {snap.libGames.map(name => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
                <select
                  className="select"
                  aria-label="Filter the library by type"
                  value={snap.libType}
                  onChange={e =>
                    engine.setLibraryFilters({type: e.target.value as EdLibType})
                  }>
                  <option value="all">All types</option>
                  <option value="raw">Raw</option>
                  <option value="edited">Edited</option>
                </select>
              </div>
            </>
          ) : null}

          <div className="ed-lib-scroll" ref={libraryRef} />
          <p className="ed-lib-hint">{ED_LIB_HINTS[snap.tab]}</p>
        </aside>

        <div className="ed-resize ed-resize-x" onPointerDown={startResize('x')}>
          <span />
        </div>

        {/* ── preview panel ─────────────────────────────────────── */}
        <div className="ed-panel ed-preview">
          <div className="ed-preview-main">
          <div className="ed-stage-wrap" ref={stageWrapRef}>
            <div className="ed-stage" ref={stageRef}>
              {snap.empty ? (
                <div className="ed-stage-empty">
                  <b>Nothing at the playhead</b>
                  <span>Drag a clip from the library onto the timeline below.</span>
                </div>
              ) : null}
              {snap.preparing ? (
                <div className="ed-stage-preparing">Preparing the H.265 preview</div>
              ) : null}
              <div className="ed-fade-overlay" ref={fadeRef} />
            </div>
          </div>

          {isText ? (
            <div className="ed-inspector">
              <div className="ed-insp-head">
                <span className="eyebrow">Title</span>
                <button
                  type="button"
                  className="ed-iconbtn"
                  onClick={() => engine.select(null)}
                  aria-label="Close the inspector">
                  <IconClose size={12} />
                </button>
              </div>

              <TextField
                label="Title text"
                value={selected.text ?? ''}
                placeholder="Title text"
                onChange={v => engine.inspectorChange('text', v)}
              />

              <label className="ed-insp-field">
                <span>Font</span>
                <Select
                  label="Font"
                  value={selected.font ?? 'display'}
                  onChange={v => engine.inspectorChange('font', v)}
                  options={Object.entries(ED_FONTS).map(([k, f]) => [k, f.label] as [string, string])}
                />
              </label>

              <label className="ed-insp-field">
                <span>
                  Size <b className="mono">{selected.size}px</b>
                </span>
                <input
                  type="range"
                  className="ed-insp-range"
                  min={16}
                  max={400}
                  step={2}
                  value={selected.size ?? 64}
                  aria-label="Title size"
                  onChange={e => engine.inspectorChange('size', e.target.value)}
                />
              </label>

              <label className="ed-insp-field">
                <span>Colour</span>
                <div className="ed-swatches">
                  {ED_SWATCHES.map(color => (
                    <button
                      key={color}
                      type="button"
                      className="ed-swatch"
                      data-active={selected.color === color || undefined}
                      style={{background: color}}
                      title={color}
                      aria-label={`Use ${color}`}
                      onClick={() => engine.inspectorChange('color', color)}
                    />
                  ))}
                </div>
              </label>

              <p className="ed-insp-pos">
                x {Math.round(selected.x ?? 0)}% · y {Math.round(selected.y ?? 0)}%, drag it on the
                preview
              </p>

              <button type="button" className="btn btn-quiet btn-danger btn-sm" onClick={() => engine.remove()}>
                Remove title
              </button>
            </div>
          ) : null}
          </div>

          <div className="ed-transport">
            <button
              type="button"
              className="btn btn-quiet btn-danger btn-sm"
              onClick={() => setResetOpen(true)}>
              Reset
            </button>
            <div className="ed-spacer" />
            <button
              type="button"
              className="ed-iconbtn ed-round"
              onClick={() => engine.seek(0)}
              title="Back to the start"
              aria-label="Back to the start">
              <StartGlyph />
            </button>
            <button
              type="button"
              className="ed-play"
              onClick={() => engine.setPlaying(!snap.playing)}
              title="Play or pause, space"
              aria-label={snap.playing ? 'Pause' : 'Play'}>
              {snap.playing ? <PauseGlyph /> : <PlayGlyph />}
            </button>
            <div className="ed-spacer" />
            <span className="ed-time mono">
              {edFmt(snap.playhead)} <span className="dim">/ {edFmt(snap.duration)}</span>
            </span>
            <button
              type="button"
              className="btn btn-sm"
              disabled={snap.duration <= 0}
              onClick={() => setExportOpen(true)}>
              Export
            </button>
          </div>
        </div>
      </div>

      <div className="ed-resize ed-resize-y" onPointerDown={startResize('y')}>
        <span />
      </div>

      {/* ── timeline panel ──────────────────────────────────────── */}
      <div className="ed-panel ed-timeline">
        <div className="ed-tl-toolbar">
          <button type="button" className="btn btn-quiet btn-sm" disabled={!snap.canSplit} onClick={() => engine.split()}>
            Split
          </button>
          <button type="button" className="btn btn-quiet btn-sm" disabled={!snap.canDetach} onClick={() => engine.detachAudio()}>
            Detach audio
          </button>
          <button
            type="button"
            className="btn btn-quiet btn-sm"
            disabled={!hasAudio}
            aria-haspopup="dialog"
            title={hasAudio ? 'Volume for the selected item' : 'Select a clip or audio item first'}
            onClick={e => {
              const r = e.currentTarget.getBoundingClientRect();
              setGainAt(prev => (prev ? null : {x: r.left, y: r.top}));
            }}>
            Volume{hasAudio && gainPercent !== 100 ? ` ${gainPercent}%` : ''}
          </button>
          <button type="button" className="btn btn-quiet btn-sm" disabled={!snap.canDuplicate} onClick={() => engine.duplicate()}>
            Duplicate
          </button>
          <button
            type="button"
            className="btn btn-quiet btn-danger btn-sm"
            disabled={!snap.canDelete}
            onClick={() => engine.remove()}>
            Delete
          </button>
          <div className="ed-spacer" />
          <span className="ed-pps mono">{Math.round(snap.pps)} px/s</span>
          <button type="button" className="ed-iconbtn" onClick={() => engine.zoom(1 / 1.3)} title="Zoom out" aria-label="Zoom out">
            <MinusGlyph />
          </button>
          <button type="button" className="ed-iconbtn" onClick={() => engine.zoom(1.3)} title="Zoom in" aria-label="Zoom in">
            <PlusGlyph />
          </button>
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => engine.fit()}>
            Fit
          </button>
          <AddTrackButton onAdd={type => engine.addTrack(type)} />
        </div>
        <div className="ed-tl-scroll" ref={scrollRef}>
          <div className="ed-tl-canvas" ref={canvasRef} />
        </div>
      </div>

      <Modal
        open={resetOpen}
        title="Clear the timeline?"
        onClose={() => setResetOpen(false)}
        footer={
          <>
            <button type="button" className="btn btn-quiet" onClick={() => setResetOpen(false)}>
              Keep it
            </button>
            <button
              type="button"
              className="btn btn-danger-solid"
              onClick={() => {
                setResetOpen(false);
                engine.reset();
              }}>
              Clear
            </button>
          </>
        }>
        <p>Every clip, title and transition on the timeline goes. Your clips stay on disk.</p>
      </Modal>

      {gainAt && selected && hasAudio ? (
        <GainPopover
          at={gainAt}
          percent={gainPercent}
          muted={Boolean(selected.muted)}
          onChange={value => engine.setItemGain(selected.id, value / 100)}
          onClose={() => setGainAt(null)}
        />
      ) : null}

      <ExportModal
        open={exportOpen}        onClose={() => setExportOpen(false)}
        engine={engine}
        clips={state.clips}
        duration={snap.duration}
        libraryDir={(config?.output?.directory as string) ?? '~/Videos/Vice'}
        accent={ACCENTS[accent].base}
        recording={state.status.recording || state.status.session_active}
        notify={notify}
        onExported={() => dispatch({type: 'setView', view: 'editor'})}
      />
    </div>
  );
}

/**
 * Volume for one timeline item, anchored above the button that opened it.
 *
 * A popover rather than a standing panel: adjusting a clip's level is an
 * occasional thing, and a permanent slider was taking preview space away from
 * the work every time anything was selected.
 */
function GainPopover({
  at,
  percent,
  muted,
  onChange,
  onClose,
}: {
  at: {x: number; y: number};
  percent: number;
  muted: boolean;
  onChange: (percent: number) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);

  useEscape(true, onClose);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const margin = 8;
    // Sits above its button, and is pulled back inside the window if the
    // button is near an edge.
    setPos({
      x: Math.max(margin, Math.min(at.x, window.innerWidth - node.offsetWidth - margin)),
      y: Math.max(margin, at.y - node.offsetHeight - 8),
    });
  }, [at]);

  useEffect(() => {
    const dismiss = (e: Event) => {
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [onClose]);

  return (
    <div className="ed-gain-pop" ref={ref} style={{left: pos.x, top: pos.y}} role="dialog" aria-label="Item volume">
      <div className="ed-gain-row">
        <span className="eyebrow">Volume</span>
        <span className="mono">{percent}%</span>
      </div>
      <input
        type="range"
        className="ed-gain"
        min={0}
        max={200}
        step={1}
        value={percent}
        disabled={muted}
        aria-label="Item volume"
        onChange={e => onChange(Number(e.target.value))}
      />
      {muted ? (
        <p className="ed-insp-hint">Muted, so this has no effect until you unmute it.</p>
      ) : percent > 100 ? (
        <p className="ed-insp-hint">Above 100% boosts, which can clip a loud source.</p>
      ) : null}
      <button
        type="button"
        className="btn btn-quiet btn-sm"
        disabled={percent === 100}
        onClick={() => onChange(100)}>
        Reset to 100%
      </button>
    </div>
  );
}

/** Export runs on the daemon, and its progress arrives over the WebSocket. */function ExportModal({
  open,
  onClose,
  engine,
  clips,
  duration,
  libraryDir,
  accent,
  recording,
  notify,
}: {
  open: boolean;
  onClose: () => void;
  engine: EditorEngine;
  clips: Clip[];
  duration: number;
  libraryDir: string;
  accent: string;
  recording: boolean;
  notify: ReturnType<typeof useStore>['notify'];
  onExported: () => void;
}) {
  const [name, setName] = useState('');
  const [location, setLocation] = useState('library');
  const [custom, setCustom] = useState('');
  const [addToLibrary, setAddToLibrary] = useState(true);

  // Export size, frame rate and game tag live on the project, so they persist
  // with the edit rather than being re-chosen on every export.
  const project = engine.project();
  const viewport = normalizeResolution(project?.viewport ?? null);
  const sourceClips = useMemo(() => {
    const ids = new Set((project?.items ?? []).map(i => i.clipId).filter(Boolean));
    return clips.filter(c => ids.has(c.slug));
  }, [project, clips]);

  const presets = useMemo(() => presetResolutions(viewport), [viewport]);
  const autoFps = useMemo(() => sourceFps(sourceClips), [sourceClips]);
  const games = useMemo(() => sourceGames(sourceClips), [sourceClips]);

  const currentExport = normalizeResolution(project?.export ?? null);
  const resolutionValueNow = currentExport ? resolutionValue(currentExport) : 'match';
  const fpsValueNow = project?.fps ? String(project.fps) : 'auto';
  const [game, setGame] = useState('');
  const gameListId = useId();
  const [phase, setPhase] = useState<'form' | 'busy' | 'done'>('form');
  const [progress, setProgress] = useState(0);
  const [donePath, setDonePath] = useState('');
  const jobRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPhase('form');
    setProgress(0);
    // Seed the tag from the sources, so an untouched export is labelled the
    // same way the daemon would label it if it were inferring.
    setGame(inferExportGame(sourceClips));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Export progress belongs to whoever started the render, so it is taken
  // straight off the socket rather than through the store.
  useEffect(() => {
    if (!open) return;
    return onWsMessage(raw => {
      const msg = raw as {
        type?: string;
        job_id?: string;
        progress?: number;
        path?: string;
        error?: string;
        canceled?: boolean;
      };
      if (!msg.type?.startsWith('export_') || msg.job_id !== jobRef.current) return;
      if (msg.type === 'export_progress') {
        setProgress(Math.min(100, Math.round((msg.progress ?? 0) * 100)));
      } else if (msg.type === 'export_done') {
        jobRef.current = null;
        setDonePath(msg.path ?? '');
        setPhase('done');
      } else if (msg.type === 'export_error') {
        jobRef.current = null;
        setPhase('form');
        notify({
          kind: msg.canceled ? 'info' : 'error',
          title: msg.canceled ? 'Export canceled' : 'Export failed',
          detail: msg.canceled ? undefined : msg.error,
          tone: msg.canceled ? 'neutral' : 'error',
          holdMs: 7000,
        });
      }
    });
  }, [open, notify]);

  const dir =
    location === 'library' ? libraryDir : location === 'videos' ? '~/Videos' : custom.trim() || '';
  const summary = `${Math.round(duration)}s · H.264 and AAC into ${dir || 'a folder you pick'}/${
    (name.trim() || 'Vice_Edit_N').replace(/\.mp4$/i, '')
  }.mp4`;

  const start = async () => {
    if (location === 'custom' && !custom.trim()) {
      notify({kind: 'error', title: 'Pick a folder for the export', tone: 'error', holdMs: 4000});
      return;
    }
    if (engine.isDirty()) await engine.saveNow();
    const body: Record<string, unknown> = {
      project: engine.project(),
      location,
      add_to_library: addToLibrary,
      accent,
      // The daemon treats a present "game" key, even an empty one, as the
      // picker's explicit choice, and infers only when the key is absent.
      // The field is always shown and pre-filled with what inference would
      // pick, so sending it always is the honest reading: what is on screen
      // is what gets applied, and clearing it means untagged on purpose.
      game: game.trim(),
    };
    if (name.trim()) body.filename = name.trim();
    if (location === 'custom') body.path = custom.trim();
    try {
      const result = (await api.startExport(body)) as {
        ok?: boolean;
        job_id?: string;
        path?: string;
        error?: string;
        errors?: string[];
      };
      if (result.ok === false || !result.job_id) {
        throw new Error(result.error || result.errors?.[0] || 'The export was refused');
      }
      jobRef.current = result.job_id;
      setDonePath(result.path ?? '');
      setProgress(0);
      setPhase('busy');
    } catch (err) {
      notify({
        kind: 'error',
        title: 'Could not start the export',
        detail: (err as Error).message,
        tone: 'error',
        holdMs: 8000,
      });
    }
  };

  return (
    <Modal
      open={open}
      title="Export video"
      wide
      onClose={() => {
        // A render in flight is the daemon's job now; closing would orphan it.
        if (phase !== 'busy') onClose();
      }}
      footer={
        phase === 'form' ? (
          <>
            <button type="button" className="btn btn-quiet" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn" onClick={() => void start()}>
              Start export
            </button>
          </>
        ) : phase === 'busy' ? (
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => {
              if (jobRef.current) void api.cancelExport(jobRef.current).catch(() => {});
            }}>
            Cancel export
          </button>
        ) : (
          <button type="button" className="btn" onClick={onClose}>
            Done
          </button>
        )
      }>
      {phase === 'form' ? (
        <>
          <label className="ed-export-field">
            <span>Save as</span>
            <TextField
              label="Export filename"
              wide
              value={name}
              placeholder="Vice_Edit_1 (automatic if empty)"
              onChange={setName}
            />
          </label>
          <label className="ed-export-field">
            <span>Location</span>
            <Select
              label="Export location"
              value={location}
              onChange={setLocation}
              options={[
                ['library', 'Vice library (default)'],
                ['videos', '~/Videos'],
                ['custom', 'Custom path'],
              ]}
            />
          </label>

          <label className="ed-export-field">
            <span>Resolution</span>
            <Select
              label="Export resolution"
              value={resolutionValueNow}
              onChange={value =>
                engine.patchProject({
                  export: value === 'match' ? null : resolutionFromValue(value),
                })
              }
              options={[
                [
                  'match',
                  viewport
                    ? `Match canvas (${viewport.width} x ${viewport.height})`
                    : 'Match canvas',
                ],
                ...presets.map(
                  r => [resolutionValue(r), `${r.width} x ${r.height}`] as [string, string],
                ),
              ]}
            />
          </label>

          <label className="ed-export-field">
            <span>Frame rate</span>
            <Select
              label="Export frame rate"
              value={fpsValueNow}
              onChange={value =>
                engine.patchProject({fps: value === 'auto' ? null : normalizeFps(value)})
              }
              options={[
                ['auto', `Follow the sources (${formatFps(autoFps)} fps)`],
                ...FPS_PRESETS.map(
                  f => [String(f), `${formatFps(f)} fps`] as [string, string],
                ),
              ]}
            />
          </label>

          <label className="ed-export-field">
            <span>Game</span>
            <input
              className="text-input"
              list={gameListId}
              value={game}
              placeholder="Untagged"
              spellCheck={false}
              onChange={e => setGame(e.target.value)}
            />
            <datalist id={gameListId}>
              {games.map(name => (
                <option key={name} value={name} />
              ))}
              {games.length > 1 ? <option value={MULTIPLE_GAMES} /> : null}
            </datalist>
          </label>
          {location === 'custom' ? (
            <label className="ed-export-field">
              <span>Folder</span>
              <TextField
                label="Export folder"
                wide
                mono
                value={custom}
                placeholder="/home/you/Videos/edits"
                onChange={setCustom}
              />
            </label>
          ) : null}
          {location !== 'library' ? (
            <label className="ed-export-field">
              <span>Also add to the Vice library</span>
              <Toggle
                label="Also add to the Vice library"
                checked={addToLibrary}
                onChange={setAddToLibrary}
              />
            </label>
          ) : null}
          <p className="ed-export-summary mono">{summary}</p>
          {recording ? (
            <p className="ed-export-warn">
              Vice is recording right now. Exporting will compete with the encoder for the GPU, so
              expect the game to stutter.
            </p>
          ) : null}
        </>
      ) : phase === 'busy' ? (
        <>
          <p>Encoding H.264. You can leave this open or carry on elsewhere in Vice.</p>
          <div className="ed-progress">
            <div className="ed-progress-fill" style={{width: `${progress}%`}} />
          </div>
          <p className="mono ed-progress-label">{progress}% encoding</p>
        </>
      ) : (
        <>
          <p>Exported.</p>
          <p className="mono ed-export-path">{donePath}</p>
        </>
      )}
    </Modal>
  );
}

function AddTrackButton({onAdd}: {onAdd: (type: 'video' | 'audio') => void}) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState({x: 0, y: 0});
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // The menu opens upward out of a panel with overflow: hidden, so it was
  // being clipped rather than stacked underneath. Fixed positioning takes it
  // out of that box entirely.
  useLayoutEffect(() => {
    const node = menuRef.current;
    const button = ref.current?.querySelector('button');
    if (!open || !node || !button) return;
    const r = button.getBoundingClientRect();
    // offsetWidth/offsetHeight, not a client rect: the menu plays a scale()
    // entry animation and a live rect reports the transformed box.
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    setAt({
      x: Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)),
      y: Math.max(8, r.top - h - 6),
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const id = window.setTimeout(() => document.addEventListener('pointerdown', dismiss, true), 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('pointerdown', dismiss, true);
    };
  }, [open]);

  return (
    <div className="ed-addtrack" ref={ref}>
      <button type="button" className="btn btn-quiet btn-sm" onClick={() => setOpen(v => !v)}>
        Track
      </button>
      {open ? (
        <div className="ed-addtrack-menu" role="menu" ref={menuRef} style={{left: at.x, top: at.y}}>
          <button
            type="button"
            onClick={() => {
              onAdd('video');
              setOpen(false);
            }}>
            Video track
          </button>
          <button
            type="button"
            onClick={() => {
              onAdd('audio');
              setOpen(false);
            }}>
            Audio track
          </button>
        </div>
      ) : null}
    </div>
  );
}

const stroke = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

const SearchGlyph = () => (
  <svg {...stroke} width={13} height={13}>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </svg>
);
const StartGlyph = () => (
  <svg {...stroke} width={13} height={13}>
    <polygon points="19 20 9 12 19 4 19 20" />
    <line x1="5" x2="5" y1="19" y2="5" />
  </svg>
);
const PlayGlyph = () => (
  <svg viewBox="0 0 24 24" width={14} height={14} fill="currentColor" aria-hidden="true">
    <path d="M7 4l13 8-13 8z" />
  </svg>
);
const PauseGlyph = () => (
  <svg viewBox="0 0 24 24" width={14} height={14} fill="currentColor" aria-hidden="true">
    <path d="M7 4h3.5v16H7zM13.5 4H17v16h-3.5z" />
  </svg>
);
const MinusGlyph = () => (
  <svg {...stroke} width={12} height={12}>
    <path d="M5 12h14" />
  </svg>
);
const PlusGlyph = () => (
  <svg {...stroke} width={12} height={12}>
    <path d="M5 12h14M12 5v14" />
  </svg>
);
