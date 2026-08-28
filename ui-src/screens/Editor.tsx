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
  shareAspect,
  sourceFps,
  sourceGames,
} from '../lib/editorExport';
import type {Clip} from '../lib/types';
import {ACCENTS} from '../theme/accents';
import {useStore} from '../state/store';
import {createEditorEngine, type EditorEngine} from '../engine/editor';
import {ED_FONTS, ED_SWATCHES, edFmt} from '../engine/editorConstants';
import type {EdProject, EdSnapshot, EdTab, EdLibType} from '../engine/editorTypes';
import {Modal} from '../components/Modal';
import {IconClose} from '../components/Icons';
import {Select, TextField, Toggle} from '../components/settings/Fields';
import {t} from '../lib/i18n';
import {getPreviewVolume, setPreviewVolume, subscribePreviewVolume} from '../lib/previewVolume';

const EDITOR_LIB_HINT: Record<EdTab, string> = {
  library: 'editor.libHintLibrary',
  effects: 'editor.libHintEffects',
  text: 'editor.libHintText',
};

const TABS: Array<[EdTab, () => string]> = [
  ['library', () => t('editor.tabLibrary')],
  ['effects', () => t('editor.tabEffects')],
  ['text', () => t('editor.tabText')],
];

function mainSourceResolution(project: EdProject | null, clips: Clip[]) {
  const videoTrackIds = (project?.tracks ?? [])
    .filter(track => track.type === 'video')
    .map(track => track.id);
  const mainTrackId = videoTrackIds[videoTrackIds.length - 1];
  const videoItems = (project?.items ?? [])
    .filter(item => item.kind === 'clip' && videoTrackIds.includes(item.trackId))
    .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))
  const mainClip =
    videoItems
      .filter(item => item.trackId === mainTrackId)
      .map(item => clips.find(clip => clip.slug === item.clipId))
      .find(clip => Boolean(clip && normalizeResolution({width: clip.width, height: clip.height}))) ??
    videoItems
      .map(item => clips.find(clip => clip.slug === item.clipId))
    .find(clip => Boolean(clip && normalizeResolution({width: clip.width, height: clip.height})));
  return normalizeResolution(mainClip ? {width: mainClip.width, height: mainClip.height} : null);
}

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
  const [previewVolume, setPreviewVolumeState] = useState(() => getPreviewVolume());
  const [canvasWidth, setCanvasWidth] = useState('');
  const [canvasHeight, setCanvasHeight] = useState('');

  useEffect(() => engine.subscribe(setSnap), [engine]);
  useEffect(() => subscribePreviewVolume(setPreviewVolumeState), []);

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

  // Selected-item gain is an occasional adjustment, so it opens on demand
  // rather than taking a standing panel beside the preview.
  const [gainAt, setGainAt] = useState<{x: number; y: number} | null>(null);
  const selected = snap.selected;
  const isText = selected?.kind === 'text';
  const hasAudio = Boolean(selected) && !isText;
  const gainPercent = Math.round((selected?.gain ?? 1) * 100);
  const project = engine.project();
  const sourceViewport = mainSourceResolution(project, clips);
  const savedViewport = normalizeResolution(project?.viewport ?? null);

  useEffect(() => {
    setCanvasWidth(savedViewport ? String(savedViewport.width) : '');
    setCanvasHeight(savedViewport ? String(savedViewport.height) : '');
  }, [savedViewport?.width, savedViewport?.height]);

  // The popover belongs to the item it was opened for.
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
            {TABS.map(([id, tabLabel]) => (
              <button
                key={id}
                type="button"
                role="tab"
                className="ed-tab"
                aria-selected={snap.tab === id}
                onClick={() => engine.setTab(id)}>
                {tabLabel()}
              </button>
            ))}
          </div>

          {snap.tab === 'library' ? (
            <>
              <div className="ed-lib-search">
                <SearchGlyph />
                <input
                  value={snap.query}
                  placeholder={t('editor.searchClips')}
                  aria-label={t('editor.searchClips')}
                  spellCheck={false}
                  onChange={e => engine.search(e.target.value)}
                />
              </div>
              <div className="ed-lib-filters">
                <select
                  className="select"
                  aria-label={t('editor.filterByGame')}
                  value={snap.libGame}
                  onChange={e => engine.setLibraryFilters({game: e.target.value})}>
                  <option value="">{t('editor.allGames')}</option>
                  {snap.libGames.map(name => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
                <select
                  className="select"
                  aria-label={t('editor.filterByType')}
                  value={snap.libType}
                  onChange={e =>
                    engine.setLibraryFilters({type: e.target.value as EdLibType})
                  }>
                  <option value="all">{t('editor.allTypes')}</option>
                  <option value="raw">{t('editor.typeRaw')}</option>
                  <option value="edited">{t('editor.typeEdited')}</option>
                </select>
              </div>
            </>
          ) : null}

          <div className="ed-lib-scroll" ref={libraryRef} />
          <p className="ed-lib-hint">{t(EDITOR_LIB_HINT[snap.tab])}</p>
        </aside>

        <div className="ed-resize ed-resize-x" onPointerDown={startResize('x')}>
          <span />
        </div>

        {/* ── preview panel ─────────────────────────────────────── */}
        <div className="ed-panel ed-preview">
          <div className="ed-preview-toolbar" role="toolbar" aria-label="Preview controls">
            <div className="ed-preview-aspect">
              <span className="ed-preview-label">Canvas</span>
              <button
                type="button"
                className="ed-aspect"
                aria-pressed={!savedViewport}
                onClick={() => {
                  engine.patchProject({viewport: null, export: null});
                  setCanvasWidth('');
                  setCanvasHeight('');
                }}>
                Match clip{sourceViewport ? ` (${sourceViewport.width} x ${sourceViewport.height})` : ''}
              </button>
              <div className="ed-canvas-size" role="group" aria-label="Custom canvas resolution">
                <input
                  type="number"
                  min={64}
                  max={7680}
                  step={2}
                  value={canvasWidth}
                  placeholder="Width"
                  aria-label="Canvas width"
                  onChange={e => setCanvasWidth(e.target.value)}
                  onBlur={() => {
                    const width = Number(canvasWidth);
                    const height = Number(canvasHeight);
                    if (
                      Number.isInteger(width) &&
                      Number.isInteger(height) &&
                      width >= 64 &&
                      height >= 64 &&
                      width <= 7680 &&
                      height <= 7680 &&
                      width % 2 === 0 &&
                      height % 2 === 0
                    ) {
                      engine.patchProject({viewport: {width, height}, export: null});
                    }
                  }}
                />
                <span aria-hidden="true">x</span>
                <input
                  type="number"
                  min={64}
                  max={7680}
                  step={2}
                  value={canvasHeight}
                  placeholder="Height"
                  aria-label="Canvas height"
                  onChange={e => setCanvasHeight(e.target.value)}
                  onBlur={() => {
                    const width = Number(canvasWidth);
                    const height = Number(canvasHeight);
                    if (
                      Number.isInteger(width) &&
                      Number.isInteger(height) &&
                      width >= 64 &&
                      height >= 64 &&
                      width <= 7680 &&
                      height <= 7680 &&
                      width % 2 === 0 &&
                      height % 2 === 0
                    ) {
                      engine.patchProject({viewport: {width, height}, export: null});
                    }
                  }}
                />
              </div>
            </div>
            <label className="ed-preview-volume">
              <span className="ed-preview-label">{t('settings.previewVolume')}</span>
              <span className="mono">
                {previewVolume > 0 ? `${Math.round(previewVolume * 100)}%` : t('settings.volumeOff')}
              </span>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={Math.round(previewVolume * 100)}
                aria-label={t('settings.previewVolume')}
                title={t('settings.previewVolumeHelp')}
                onChange={e =>
                  setPreviewVolume(Number(e.target.value) / 100, {
                    onError: message =>
                      notify({
                        kind: 'error',
                        title: t('settings.previewVolumeSaveFailed'),
                        detail: message,
                        tone: 'error',
                        holdMs: 6000,
                      }),
                  })
                }
              />
            </label>
          </div>
          <div className="ed-preview-main">
            <div className="ed-stage-wrap" ref={stageWrapRef}>
              <div className="ed-stage" ref={stageRef}>
                {snap.empty ? (
                  <div className="ed-stage-empty">
                    <b>{t('editor.nothingAtPlayhead')}</b>
                    <span>{t('editor.dragFromLibrary')}</span>
                  </div>
                ) : null}
                {snap.preparing ? (
                  <div className="ed-stage-preparing">{t('editor.preparingPreview')}</div>
                ) : null}
                <div className="ed-fade-overlay" ref={fadeRef} />
              </div>
            </div>

            {isText ? (
              <div className="ed-inspector">
                <div className="ed-insp-head">
                  <span className="eyebrow">{t('editor.titleSection')}</span>
                  <button
                    type="button"
                    className="ed-iconbtn"
                    onClick={() => engine.select(null)}
                    aria-label={t('editor.closeInspector')}>
                    <IconClose size={12} />
                  </button>
                </div>

                <TextField
                  label={t('editor.titleText')}
                  value={selected.text ?? ''}
                  placeholder={t('editor.titleText')}
                  onChange={v => engine.inspectorChange('text', v)}
                />

              <label className="ed-insp-field">
                <span>{t('editor.font')}</span>
                <Select
                  label={t('editor.font')}
                  value={selected.font ?? 'display'}
                  onChange={v => engine.inspectorChange('font', v)}
                  options={Object.entries(ED_FONTS).map(([k, f]) => [k, f.label] as [string, string])}
                />
              </label>
              <label className="ed-insp-field">
                <span>
                  {t('editor.size')} <b className="mono">{selected.size}px</b>
                </span>
                <input
                  type="range"
                  className="ed-insp-range"
                  min={16}
                  max={400}
                  step={2}
                  value={selected.size ?? 64}
                  aria-label={t('editor.titleSize')}
                  onChange={e => engine.inspectorChange('size', e.target.value)}
                />
              </label>

              <label className="ed-insp-field">
                <span>{t('editor.colour')}</span>
                <div className="ed-swatches">
                  {ED_SWATCHES.map(color => (
                    <button
                      key={color}
                      type="button"
                      className="ed-swatch"
                      data-active={selected.color === color || undefined}
                      style={{background: color}}
                      title={color}
                      aria-label={t('editor.useColour', {color})}
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
                {t('editor.removeTitle')}
              </button>
              </div>
            ) : null}
          </div>

          <div className="ed-transport">
            <button
              type="button"
              className="btn btn-quiet btn-danger btn-sm"
              onClick={() => setResetOpen(true)}>
              {t('editor.reset')}
            </button>
            <div className="ed-spacer" />
            <button
              type="button"
              className="ed-iconbtn ed-round"
              onClick={() => engine.seek(0)}
              title={t('editor.backToStart')}
              aria-label={t('editor.backToStart')}>
              <StartGlyph />
            </button>
            <button
              type="button"
              className="ed-play"
              onClick={() => engine.setPlaying(!snap.playing)}
              title={t('editor.playPause')}
              aria-label={snap.playing ? t('editor.pause') : t('editor.play')}>
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
              {t('editor.exportBtn')}
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
            {t('editor.split')}
          </button>
          <button type="button" className="btn btn-quiet btn-sm" disabled={!snap.canDetach} onClick={() => engine.detachAudio()}>
            {t('editor.detachAudio')}
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
            Item volume{hasAudio && gainPercent !== 100 ? ` ${gainPercent}%` : ''}
          </button>
          <button type="button" className="btn btn-quiet btn-sm" disabled={!snap.canDuplicate} onClick={() => engine.duplicate()}>
            {t('editor.duplicate')}
          </button>
          <button
            type="button"
            className="btn btn-quiet btn-danger btn-sm"
            disabled={!snap.canDelete}
            onClick={() => engine.remove()}>
            {t('common.delete')}
          </button>
          <div className="ed-spacer" />
          <span className="ed-pps mono">{Math.round(snap.pps)} px/s</span>
          <button type="button" className="ed-iconbtn" onClick={() => engine.zoom(1 / 1.3)} title={t('editor.zoomOut')} aria-label={t('editor.zoomOut')}>
            <MinusGlyph />
          </button>
          <button type="button" className="ed-iconbtn" onClick={() => engine.zoom(1.3)} title={t('editor.zoomIn')} aria-label={t('editor.zoomIn')}>
            <PlusGlyph />
          </button>
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => engine.fit()}>
            {t('editor.fit')}
          </button>
          <AddTrackButton onAdd={type => engine.addTrack(type)} />
          <button
            type="button"
            className="ed-iconbtn"
            onClick={() => engine.openShortcutHelp()}
            title={t('editor.shortcuts')}
            aria-label={t('editor.shortcuts')}>
            ?
          </button>
        </div>
        <div className="ed-tl-scroll" ref={scrollRef}>
          <div className="ed-tl-canvas" ref={canvasRef} />
        </div>
      </div>

      {snap.shortcutHelpOpen ? (
        <ShortcutHelpModal onClose={() => engine.closeShortcutHelp()} />
      ) : null}

      <Modal
        open={resetOpen}
        title={t('editor.clearTitle')}
        onClose={() => setResetOpen(false)}
        footer={
          <>
            <button type="button" className="btn btn-quiet" onClick={() => setResetOpen(false)}>
              {t('common.keepIt')}
            </button>
            <button
              type="button"
              className="btn btn-danger-solid"
              onClick={() => {
                setResetOpen(false);
                engine.reset();
              }}>
              {t('editor.clear')}
            </button>
          </>
        }>
        <p>{t('editor.clearBody')}</p>
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

/** True on macOS, where the modifier key shown in shortcut hints is Cmd rather than Ctrl. */
const isMac = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPod|iPad/.test(navigator.platform ?? '');

const modKeyLabel = () => (isMac() ? '⌘' : 'Ctrl');

const SHORTCUT_ROWS: Array<[string, string]> = [
  ['Space', 'Play / pause'],
  ['Delete / Backspace', 'Delete selection'],
  ['Shift+Delete / Shift+Backspace', 'Ripple delete (closes the gap)'],
  [`${modKeyLabel()}+Z`, 'Undo'],
  [`${modKeyLabel()}+Shift+Z`, 'Redo'],
  [`${modKeyLabel()}+C`, 'Copy'],
  [`${modKeyLabel()}+V`, 'Paste'],
  [`${modKeyLabel()}+X`, 'Cut'],
  [`${modKeyLabel()}+D`, 'Duplicate'],
  ['S', 'Split at playhead'],
  ['← / →', 'Seek one frame (Shift: one second)'],
  ['↑ / ↓', 'Jump to previous / next edit point'],
  ['Home / End', 'Seek to start / end'],
  ['F', 'Fit timeline zoom to content'],
  ['+ / -', 'Zoom in / out'],
  ['Ctrl+Scroll', 'Zoom timeline, centered on cursor'],
  ['Esc', 'Clear selection'],
  ['?', 'Show this help'],
];

/** Lists every editor keyboard shortcut. Triggered by "?", closed by Esc or the close button. */
function ShortcutHelpModal({onClose}: {onClose: () => void}) {
  return (
    <Modal open title={t('editor.shortcuts')} onClose={onClose}>
      <table className="ed-shortcut-table">
        <tbody>
          {SHORTCUT_ROWS.map(([key, desc]) => (
            <tr key={key}>
              <td className="mono">{key}</td>
              <td>{desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}

/** Volume for one timeline item, anchored above the button that opens it. */
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
        <span className="eyebrow">Item volume</span>
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
  const [videoEncoder, setVideoEncoder] = useState('auto');
  const [activeEncoder, setActiveEncoder] = useState('');

  // Export size, frame rate and game tag live on the project, so they persist
  // with the edit rather than being re-chosen every export.
  const project = engine.project();
  const viewport = normalizeResolution(project?.viewport ?? null);
  const sourceClips = useMemo(() => {
    const ids = new Set((project?.items ?? []).map(i => i.clipId).filter(Boolean));
    return clips.filter(c => ids.has(c.slug));
  }, [project, clips]);

  // The daemon falls back to the first clip's resolution when project.viewport
  // is unset; mirrored here so "Match clip" shows the size that would actually
  // be used rather than nothing.
  const clipResolution = useMemo(() => {
    const videoTrackIds = new Set(
      (project?.tracks ?? []).filter(track => track.type === 'video').map(track => track.id),
    );
    const videoTrackIdList = [...videoTrackIds];
    const mainTrackId = videoTrackIdList[videoTrackIdList.length - 1];
    const mainItem = (project?.items ?? [])
      .filter(item => item.kind === 'clip' && item.trackId === mainTrackId)
      .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))[0];
    const mainClip = mainItem ? clips.find(clip => clip.slug === mainItem.clipId) : undefined;
    return normalizeResolution(mainClip ? {width: mainClip.width, height: mainClip.height} : null);
  }, [project, clips]);
  const effectiveViewport = viewport ?? clipResolution;

  const presets = useMemo(() => presetResolutions(effectiveViewport), [effectiveViewport]);
  const autoFps = useMemo(() => sourceFps(sourceClips), [sourceClips]);
  const games = useMemo(() => sourceGames(sourceClips), [sourceClips]);

  const viewportValueNow = viewport ? resolutionValue(viewport) : 'match';
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
    setActiveEncoder('');
    // Pre-filled with what the daemon would infer, so an untouched export is
    // tagged the same either way.
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
          title: msg.canceled ? t('editor.exportCanceled') : t('editor.exportFailed'),
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
  const encoderLabel =
    activeEncoder === 'h264_nvenc'
      ? 'NVIDIA NVENC (GPU)'
      : activeEncoder === 'h264_vaapi'
        ? 'VAAPI (GPU)'
        : activeEncoder === 'libx264'
          ? 'x264 (CPU)'
          : videoEncoder === 'libx264'
            ? 'x264 (CPU)'
            : 'Automatic GPU preference';

  const start = async () => {
    if (location === 'custom' && !custom.trim()) {
      notify({kind: 'error', title: t('editor.pickFolder'), tone: 'error', holdMs: 4000});
      return;
    }
    if (engine.isDirty()) await engine.saveNow();
    const body: Record<string, unknown> = {
      project: engine.project(),
      location,
      add_to_library: addToLibrary,
      accent,
      // The daemon treats a present "game" key, even an empty one, as an
      // explicit choice and infers only when it is absent. The field is always
      // shown, so clearing it means untagged on purpose.
      game: game.trim(),
      video_encoder: videoEncoder,
    };
    if (name.trim()) body.filename = name.trim();
    if (location === 'custom') body.path = custom.trim();
    try {
      const result = (await api.startExport(body)) as {
        ok?: boolean;
        job_id?: string;
        path?: string;
        encoder?: string;
        error?: string;
        errors?: string[];
      };
      if (result.ok === false || !result.job_id) {
        throw new Error(result.error || result.errors?.[0] || t('editor.exportRefused'));
      }
      jobRef.current = result.job_id;
      setActiveEncoder(result.encoder ?? videoEncoder);
      setDonePath(result.path ?? '');
      setProgress(0);
      setPhase('busy');
    } catch (err) {
      notify({
        kind: 'error',
        title: t('editor.errStartExport'),
        detail: (err as Error).message,
        tone: 'error',
        holdMs: 8000,
      });
    }
  };

  return (
    <Modal
      open={open}
      title={t('editor.exportVideo')}
      wide
      onClose={() => {
        // A render in flight is the daemon's job now; closing would orphan it.
        if (phase !== 'busy') onClose();
      }}
      footer={
        phase === 'form' ? (
          <>
            <button type="button" className="btn btn-quiet" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button type="button" className="btn" onClick={() => void start()}>
              {t('editor.startExport')}
            </button>
          </>
        ) : phase === 'busy' ? (
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => {
              if (jobRef.current) void api.cancelExport(jobRef.current).catch(() => {});
            }}>
            {t('editor.cancelExport')}
          </button>
        ) : (
          <button type="button" className="btn" onClick={onClose}>
            {t('editor.done')}
          </button>
        )
      }>
      {phase === 'form' ? (
        <>
          <label className="ed-export-field">
            <span>{t('editor.saveAs')}</span>
            <TextField
              label={t('editor.exportFilename')}
              wide
              value={name}
              placeholder={t('editor.exportFilenamePlaceholder')}
              onChange={setName}
            />
          </label>
          <label className="ed-export-field">
            <span>{t('editor.location')}</span>
            <Select
              label={t('editor.exportLocation')}
              value={location}
              onChange={setLocation}
              options={[
                ['library', t('editor.viceLibrary')],
                ['videos', '~/Videos'],
                ['custom', t('editor.customPath')],
              ]}
            />
          </label>

          <label className="ed-export-field">
            <span>Canvas resolution</span>
            <Select
              label="Canvas resolution"
              value={viewportValueNow}
              onChange={value => {
                const nextViewport = value === 'match' ? null : resolutionFromValue(value);
                const nextEffectiveViewport = nextViewport ?? clipResolution;
                const keepExport =
                  currentExport &&
                  nextEffectiveViewport &&
                  shareAspect(nextEffectiveViewport, currentExport);
                engine.patchProject({
                  viewport: nextViewport,
                  export: keepExport ? project?.export : null,
                });
              }}
              options={[
                [
                  'match',
                  clipResolution
                    ? `Match clip (${clipResolution.width} x ${clipResolution.height})`
                    : 'Match clip',
                ],
                ...[
                  ...(viewport ? [viewport] : []),
                  ...presets,
                ]
                  .filter(
                    (r, index, all) =>
                      all.findIndex(other => resolutionValue(other) === resolutionValue(r)) === index,
                  )
                  .map(
                    r => [resolutionValue(r), `${r.width} x ${r.height}`] as [string, string],
                  ),
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
                  effectiveViewport
                    ? `Match canvas (${effectiveViewport.width} x ${effectiveViewport.height})`
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
            <span>Video encoder</span>
            <Select
              label="Video encoder"
              value={videoEncoder}
              onChange={setVideoEncoder}
              options={[
                ['auto', 'Automatic (prefer GPU)'],
                ['libx264', 'x264 (CPU fallback)'],
              ]}
            />
          </label>
          <p className="ed-export-note">
            This export will use <strong>{encoderLabel}</strong>. Automatic mode probes
            the available Linux GPU encoder before falling back to CPU.
          </p>

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
              <span>{t('editor.folder')}</span>
              <TextField
                label={t('editor.exportFolder')}
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
              <span>{t('editor.alsoAddToLibrary')}</span>
              <Toggle
                label={t('editor.alsoAddToLibrary')}
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
          <p>
            {t('editor.encoding')} <strong>with {encoderLabel}</strong>
          </p>
          <div className="ed-progress">
            <div className="ed-progress-fill" style={{width: `${progress}%`}} />
          </div>
          <p className="mono ed-progress-label">{t('editor.encodingProgress', {percent: progress})}</p>
        </>
      ) : (
        <>
          <p>{t('editor.exported')}</p>
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
        {t('editor.addTrack')}
      </button>
      {open ? (
        <div className="ed-addtrack-menu" role="menu" ref={menuRef} style={{left: at.x, top: at.y}}>
          <button
            type="button"
            onClick={() => {
              onAdd('video');
              setOpen(false);
            }}>
            {t('editor.videoTrack')}
          </button>
          <button
            type="button"
            onClick={() => {
              onAdd('audio');
              setOpen(false);
            }}>
            {t('editor.audioTrack')}
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
