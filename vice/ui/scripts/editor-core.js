'use strict';
// editor-core.js — timeline editor state, project ops, autosave, keyboard

// ═══════════════════════════════════════════════════════════════════
// Editor state
// ═══════════════════════════════════════════════════════════════════
let edProject   = null;      // {version, tracks, items}; null until first enter
let edSel       = null;      // primary selected item id
let edSelected  = new Set(); // selected item ids; UI state, never persisted
let edRangeAnchor = null;    // same-track Shift selection anchor
let edPlayhead  = 0;
let edPlaying   = false;
let edPps       = 12;        // timeline zoom, px per second
let edClipboard = null;
let edMissing   = new Set(); // clipIds referenced by the project but not in `clips`
let edLoaded    = false;
let edDirty     = false;
let edSaveTimer = null;
let edSaveError = '';
let edUndoStack = [];
let edRedoStack = [];

const ED_PPS_MIN = 4, ED_PPS_MAX = 160;
const ED_UNDO_CAP = 50;
const ED_RES_MIN = 64, ED_RES_MAX = 7680, ED_RES_MAX_PIXELS = 7680 * 4320;
const ED_FPS_MIN = 1, ED_FPS_MAX = 240, ED_FPS_DEFAULT = 60, ED_FPS_TOLERANCE = 0.1;
const ED_GAIN_MIN = 0, ED_GAIN_MAX = 2;

const ED_FX = [
  { id: 'crossfade', name: 'Crossfade',     desc: 'Blend outgoing into incoming',      len: 1.0,
    glyph: '<rect x="3" y="8" width="11" height="11" rx="2"/><rect x="10" y="5" width="11" height="11" rx="2" opacity=".5"/>' },
  { id: 'fadeblack', name: 'Fade to black', desc: 'Dip through pure black',            len: 0.8,
    glyph: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M12 5h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-7z" fill="currentColor" stroke="none" opacity=".8"/>' },
  { id: 'fadewhite', name: 'Fade to white', desc: 'Bloom through white',               len: 0.8,
    glyph: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M12 5h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-7z" fill="currentColor" stroke="none" opacity=".3"/>' },
  { id: 'dipaccent', name: 'Dip to accent', desc: 'Flash the theme color',             len: 0.7,
    glyph: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none"/>' },
  { id: 'blurdis',   name: 'Blur dissolve', desc: 'Defocus across the cut',            len: 1.2,
    glyph: '<circle cx="9" cy="12" r="5"/><circle cx="15" cy="12" r="5" opacity=".5"/>' },
  { id: 'slide',     name: 'Slide',         desc: 'Incoming pushes in from the right', len: 0.8,
    glyph: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 12h7"/><path d="m12 9 3 3-3 3"/>' },
];

const ED_FONTS = {
  display: { label: 'Geist',          stack: "'Geist', sans-serif" },
  body:    { label: 'Inter',          stack: "'Inter', sans-serif" },
  mono:    { label: 'JetBrains Mono', stack: "'JetBrains Mono', monospace" },
};

const ED_TEXT_PRESETS = [
  { id: 'title',    name: 'Title',       font: 'display', size: 64, weight: 600, color: '#f2f5fa', sample: 'Match point',        x: 50, y: 44 },
  { id: 'subtitle', name: 'Subtitle',    font: 'body',    size: 34, weight: 500, color: '#dbe1ea', sample: 'Ranked grind',       x: 50, y: 58 },
  { id: 'caption',  name: 'Caption',     font: 'mono',    size: 22, weight: 400, color: '#b8c0cd', sample: '1920x1080 · 60 fps', x: 50, y: 88 },
  { id: 'lower',    name: 'Lower third', font: 'display', size: 40, weight: 600, color: '#f2f5fa', sample: 'Player · support',   x: 22, y: 84 },
];

const ED_SWATCHES = ['#f2f5fa', '#33adff', '#c4b5fd', '#6ee7b7', '#fdba74'];

function edCapture(el, e) {
  try { el.setPointerCapture(e.pointerId); } catch (_) {}
}

function edFx(id)   { return ED_FX.find(f => f.id === id); }
function edClipOf(it) { return clips.find(c => c.slug === it.clipId); }
function edUid()    { return 'i' + Math.random().toString(36).slice(2, 9); }
function edFmt(t)   {
  const m = Math.floor(t / 60), s = Math.floor(t % 60), d = Math.floor((t % 1) * 10);
  return `${m}:${String(s).padStart(2, '0')}.${d}`;
}
function edFmtS(t) { return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`; }
function edRound(v) { return Math.round(v * 1000) / 1000; }

function edNormalizeResolution(value) {
  const width = Number(value && value.width);
  const height = Number(value && value.height);
  if (!Number.isInteger(width) || !Number.isInteger(height)
      || width < ED_RES_MIN || height < ED_RES_MIN
      || width > ED_RES_MAX || height > ED_RES_MAX
      || width % 2 || height % 2
      || width * height > ED_RES_MAX_PIXELS) return null;
  return {width, height};
}

function edNormalizeFps(value) {
  const fps = Number(value);
  if (!Number.isFinite(fps) || fps < ED_FPS_MIN || fps > ED_FPS_MAX) return null;
  return edRound(fps);
}

function edItemGain(item) {
  const gain = typeof (item && item.gain) === 'number' ? item.gain : NaN;
  return Number.isFinite(gain)
    ? Math.max(ED_GAIN_MIN, Math.min(ED_GAIN_MAX, gain))
    : 1;
}

function edFormatFps(value) {
  const fps = edNormalizeFps(value) || ED_FPS_DEFAULT;
  return Number.isInteger(fps) ? String(fps) : String(fps).replace(/0+$/, '').replace(/\.$/, '');
}

function edResolutionFromValue(value) {
  const match = /^(\d+)x(\d+)$/.exec(String(value || ''));
  return match ? edNormalizeResolution({width: Number(match[1]), height: Number(match[2])}) : null;
}

function edResolutionValue(value) {
  return value ? `${value.width}x${value.height}` : '';
}

function edSameAspect(first, second) {
  if (!first || !second) return false;
  const lhs = first.width * second.height;
  const rhs = second.width * first.height;
  return Math.abs(lhs - rhs) <= Math.max(lhs, rhs) * 0.002;
}

function edSourceResolution() {
  if (edProject) {
    const videoTracks = edVideoTracks();
    const main = videoTracks[videoTracks.length - 1];
    const first = main && edItems(main.id).find(item => item.kind === 'clip');
    const clip = first && edClipOf(first);
    const width = Math.floor(Number(clip && clip.width) / 2) * 2;
    const height = Math.floor(Number(clip && clip.height) / 2) * 2;
    if (width > 0 && height > 0) return {width, height};
  }
  return {width: 1920, height: 1080};
}

function edAutomaticViewportKnown() {
  if (!edProject || edNormalizeResolution(edProject.viewport)) return true;
  const videoTracks = edVideoTracks();
  const main = videoTracks[videoTracks.length - 1];
  const first = main && edItems(main.id).find(item => item.kind === 'clip');
  if (!first) return true;
  const clip = edClipOf(first);
  return Boolean(edNormalizeResolution(clip));
}

function edViewportResolution() {
  return edNormalizeResolution(edProject && edProject.viewport) || edSourceResolution();
}

function edExportResolution() {
  const viewport = edViewportResolution();
  const configured = edNormalizeResolution(edProject && edProject.export);
  return configured && edSameAspect(viewport, configured) ? configured : viewport;
}

function edSourceFps() {
  if (!edProject) return ED_FPS_DEFAULT;
  const videoTracks = new Set(edVideoTracks().map(track => track.id));
  const seen = new Set();
  const rates = [];
  edProject.items.forEach(item => {
    if (item.kind !== 'clip' || !videoTracks.has(item.trackId) || seen.has(item.clipId)) return;
    seen.add(item.clipId);
    const fps = edNormalizeFps(edClipOf(item)?.fps);
    if (!fps) rates.push(null);
    else rates.push({clipId: item.clipId, fps});
  });
  if (!rates.length || rates.some(rate => !rate)) return ED_FPS_DEFAULT;

  const tracks = edVideoTracks();
  const main = tracks[tracks.length - 1];
  const first = main && edItems(main.id).find(item => item.kind === 'clip');
  const mainFps = edNormalizeFps(first && edClipOf(first)?.fps);
  const anchor = mainFps || rates[0].fps;
  return rates.every(rate => Math.abs(rate.fps - anchor) <= ED_FPS_TOLERANCE)
    ? anchor : ED_FPS_DEFAULT;
}

function edOutputFps() {
  return edNormalizeFps(edProject && edProject.fps) || edSourceFps();
}

function edSyncResolutionControls() {
  edSyncViewportControl();
  if (typeof edSyncExportResolutionControl === 'function') edSyncExportResolutionControl();
  if (typeof edSyncExportFpsControl === 'function') edSyncExportFpsControl();
  setText('ed-res-chip', `H.264 · ${edFormatFps(edOutputFps())} fps`);
  if (typeof edSizeStage === 'function') edSizeStage();
}

function edReconcileProjectResolution(notify = false) {
  if (!edProject || !Object.prototype.hasOwnProperty.call(edProject, 'export')) return false;
  const configured = edNormalizeResolution(edProject.export);
  if (!configured || (edAutomaticViewportKnown()
      && !edSameAspect(edViewportResolution(), configured))) {
    delete edProject.export;
    edSyncResolutionControls();
    if (notify) toast('Export resolution now matches the canvas', 'ok');
    return true;
  }
  return false;
}

function edSyncViewportControl() {
  const select = document.getElementById('ed-viewport-res');
  if (!select || !edProject) return;
  select.querySelectorAll('option[data-project-resolution]').forEach(option => option.remove());

  const source = edSourceResolution();
  const automatic = select.querySelector('option[value="auto"]');
  automatic.textContent = `Match clip · ${source.width} × ${source.height}`;

  const configured = edNormalizeResolution(edProject.viewport);
  const value = configured ? edResolutionValue(configured) : 'auto';
  if (![...select.options].some(option => option.value === value)) {
    if (!configured) return;
    const option = new Option(`${configured.width} × ${configured.height}`, value);
    option.dataset.projectResolution = '1';
    select.add(option);
  }
  select.value = value;
}

function edSetViewportResolution(value) {
  if (!edProject) return;
  const next = value === 'auto' ? null : edResolutionFromValue(value);
  if (value !== 'auto' && !next) {
    edSyncViewportControl();
    toast('That canvas resolution is not supported', 'err');
    return;
  }
  const current = edNormalizeResolution(edProject.viewport);
  if ((!edProject.viewport && !next)
      || (current && next && edResolutionValue(current) === edResolutionValue(next))) return;

  edBegin();
  if (next) edProject.viewport = next;
  else delete edProject.viewport;
  edCommit();
}

function edDefaultProject() {
  return {
    version: 1,
    tracks: [
      { id: 'T1', type: 'text',  label: 'T1' },
      { id: 'V2', type: 'video', label: 'V2' },
      { id: 'V1', type: 'video', label: 'V1' },
      { id: 'A1', type: 'audio', label: 'A1' },
    ],
    items: [],
  };
}

function edEnd() {
  return edProject
    ? edProject.items.reduce((m, i) => Math.max(m, i.start + i.dur), 0)
    : 0;
}

function edItems(trackId) {
  return edProject.items.filter(i => i.trackId === trackId).sort((a, b) => a.start - b.start);
}

function edItem(id) { return edProject.items.find(i => i.id === id); }
function edSelItem() { return edSel ? edItem(edSel) : null; }
function edIsSelected(id) { return Boolean(id && edSelected.has(id)); }
function edSelectedItems() {
  return edProject ? edProject.items.filter(item => edSelected.has(item.id)) : [];
}
function edSelectionCount() { return edSelected.size; }
function edVideoTracks() { return edProject.tracks.filter(t => t.type === 'video'); }
function edLastSelectedId() {
  const ids = [...edSelected];
  return ids.length ? ids[ids.length - 1] : null;
}

function edSetSelectionState(ids, primary = null, anchor = primary) {
  const valid = [...new Set(ids || [])].filter(id => edItem(id));
  edSelected = new Set(valid);
  edSel = valid.includes(primary) ? primary : (valid.length ? valid[valid.length - 1] : null);
  edRangeAnchor = valid.includes(anchor) ? anchor : edSel;
}

function edSelectOnlyState(id) {
  if (!id || !edItem(id)) edSetSelectionState([]);
  else edSetSelectionState([id], id, id);
}

function edReconcileSelection() {
  const valid = [...edSelected].filter(id => edItem(id));
  edSelected = new Set(valid);
  if (!edSel || !edSelected.has(edSel)) edSel = valid.length ? valid[valid.length - 1] : null;
  if (!edRangeAnchor || !edSelected.has(edRangeAnchor)) edRangeAnchor = edSel;
}

// Source duration for trimming bounds. Missing clips keep their timeline
// length so the layout survives until the clip returns or is removed.
function edSourceDur(it) {
  const c = edClipOf(it);
  return c && c.duration ? c.duration : (it.offset || 0) + it.dur;
}

// ═══════════════════════════════════════════════════════════════════
// Persistence
// ═══════════════════════════════════════════════════════════════════
async function edLoad() {
  try {
    const r = await fetch('/api/editor/project');
    const d = await r.json();
    edProject = d.project && Array.isArray(d.project.tracks) && d.project.tracks.length
      ? d.project : edDefaultProject();
    edMissing = new Set(d.missing || []);
  } catch (_) {
    edProject = edProject || edDefaultProject();
  }
  edReconcileSelection();
  edLoaded = true;
  if (edReconcileProjectResolution(true)) edScheduleSave();
}

function edScheduleSave() {
  edDirty = true;
  clearTimeout(edSaveTimer);
  edSaveTimer = setTimeout(edSaveNow, 800);
}

async function edSaveNow() {
  if (!edDirty || !edProject) return true;
  edReconcileProjectResolution(true);
  edDirty = false;
  try {
    const response = await fetch('/api/editor/project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(edProject),
    });
    let data = {};
    try { data = await response.json(); } catch (_) {}
    if (!response.ok || data.ok === false) {
      const message = data.error || (data.errors && data.errors[0]) || `Save failed (${response.status})`;
      throw new Error(message);
    }
    edSaveError = '';
    return true;
  } catch (err) {
    edDirty = true;
    const message = err && err.message ? err.message : 'daemon unreachable';
    if (message !== edSaveError) {
      edSaveError = message;
      toast(`Editor could not save: ${message}`, 'err');
    }
    return false;
  }
}

function edRefreshMissing() {
  const have = new Set(clips.map(c => c.slug));
  edMissing = new Set(edProject.items
    .filter(i => i.clipId && !have.has(i.clipId))
    .map(i => i.clipId));
}

// ═══════════════════════════════════════════════════════════════════
// Undo / redo — JSON snapshots pushed on every committed edit
// ═══════════════════════════════════════════════════════════════════
function edSnapshot() {
  edUndoStack.push(JSON.stringify(edProject));
  if (edUndoStack.length > ED_UNDO_CAP) edUndoStack.shift();
  edRedoStack = [];
}

function edUndo() {
  if (!edUndoStack.length) return;
  edRedoStack.push(JSON.stringify(edProject));
  edProject = JSON.parse(edUndoStack.pop());
  edAfterRestore();
}

function edRedo() {
  if (!edRedoStack.length) return;
  edUndoStack.push(JSON.stringify(edProject));
  edProject = JSON.parse(edRedoStack.pop());
  edAfterRestore();
}

function edAfterRestore() {
  edReconcileSelection();
  edRefreshMissing();
  edReconcileProjectResolution(true);
  edScheduleSave();
  edSyncResolutionControls();
  edRenderTimeline();
  edRenderPreviewFrame(true);
}

// Commit an edit: fix up junctions, re-render, autosave. `snap` was pushed
// by the caller before mutating (edBegin).
function edCommit() {
  edPruneTransitions();
  edReconcileProjectResolution(true);
  edScheduleSave();
  edSyncResolutionControls();
  edRenderTimeline();
  edRenderPreviewFrame(true);
}

function edBegin() { edSnapshot(); }

// A transition needs something to its left: keep `trans` only on items that
// either abut a left neighbor or sit at a lane position where a lead-in
// fade still makes sense (anything not at 0 has a gap, which fades from
// black anyway, so only exact duplicates of removed junctions are pruned).
function edPruneTransitions() {
  edProject.items.forEach(it => {
    if (it.trans && it.kind === 'clip') {
      const cap = Math.min(3, edRound(it.dur * 0.8));
      it.trans.len = Math.min(Math.max(0.2, it.trans.len), cap);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════
// Item ops
// ═══════════════════════════════════════════════════════════════════

// Push an item into the nearest gap on its lane so lane-mates never overlap.
function edResolve(it) {
  const mates = edProject.items
    .filter(o => o.trackId === it.trackId && o.id !== it.id)
    .sort((a, b) => a.start - b.start);
  let s = Math.max(0, it.start);
  for (let pass = 0; pass < mates.length + 1; pass++) {
    const hit = mates.find(o => s < o.start + o.dur && s + it.dur > o.start);
    if (!hit) break;
    const before = hit.start - it.dur, after = hit.start + hit.dur;
    s = (before >= 0 && Math.abs(before - s) <= Math.abs(after - s)) ? before : after;
  }
  it.start = edRound(Math.max(0, s));
  return it;
}

function edInsert(it) {
  edProject.items.push(edResolve(it));
  return it;
}

function edSnapTime(t, exclId) {
  const pts = [0, edPlayhead];
  edProject.items.forEach(i => {
    if (i.id !== exclId) pts.push(i.start, i.start + i.dur);
  });
  let best = t, bd = 8 / edPps;
  pts.forEach(p => {
    const d = Math.abs(p - t);
    if (d < bd) { bd = d; best = p; }
  });
  return Math.max(0, edRound(best));
}

// Trim limits against lane neighbors.
function edLimits(it) {
  let prevEnd = 0, nextStart = Infinity;
  edProject.items.forEach(o => {
    if (o.trackId !== it.trackId || o.id === it.id) return;
    const e = o.start + o.dur;
    if (e <= it.start + 0.001 && e > prevEnd) prevEnd = e;
    if (o.start >= it.start + it.dur - 0.001 && o.start < nextStart) nextStart = o.start;
  });
  return { prevEnd, nextStart };
}

function edAddClip(slug, trackId, t, asAudio) {
  if (!edProject) return;
  const c = clips.find(x => x.slug === slug);
  if (!c || !c.duration) { toast('That clip has no readable duration yet', 'err'); return; }
  edBegin();
  const it = edInsert({
    id: edUid(), kind: asAudio ? 'audio' : 'clip', trackId,
    clipId: slug, start: edRound(Math.max(0, t)), dur: edRound(c.duration), offset: 0, gain: 1,
  });
  edSelectOnlyState(it.id);
  edCommit();
}

function edQuickAdd(slug) {
  if (!edProject) return;
  const vts = edVideoTracks();
  const vt = vts[vts.length - 1];
  const end = edItems(vt.id).reduce((m, i) => Math.max(m, i.start + i.dur), 0);
  edAddClip(slug, vt.id, end, false);
}

function edAddText(presetId, opts = {}) {
  if (!edProject) return;
  const p = ED_TEXT_PRESETS.find(x => x.id === presetId);
  const tt = edProject.tracks.find(t => t.type === 'text');
  if (!p || !tt) return;
  edBegin();
  const it = edInsert({
    id: edUid(), kind: 'text', trackId: tt.id,
    start: edRound(Math.max(0, opts.t !== undefined ? opts.t : edPlayhead)), dur: 4,
    text: p.sample, font: p.font, size: p.size, weight: p.weight, color: p.color,
    x: opts.x !== undefined ? edRound(opts.x) : p.x,
    y: opts.y !== undefined ? edRound(opts.y) : p.y,
  });
  edSelectOnlyState(it.id);
  edCommit();
}

function edApplyFx(itemId, fxId) {
  const it = edItem(itemId), fx = edFx(fxId);
  if (!it || !fx || it.kind !== 'clip') return;
  edBegin();
  it.trans = { fx: fxId, len: Math.min(fx.len, edRound(it.dur * 0.8)) };
  edSelectOnlyState(itemId);
  edCommit();
}

function edSplitSel() {
  const eligible = edSelectedItems().filter(it =>
    edPlayhead > it.start + 0.2 && edPlayhead < it.start + it.dur - 0.2);
  if (!eligible.length) return;
  edBegin();
  const t = edPlayhead;
  const selected = new Set(edSelected);
  eligible.forEach(it => {
    const right = Object.assign({}, it, {
      id: edUid(), start: edRound(t), dur: edRound(it.start + it.dur - t),
    });
    if (it.kind === 'clip' || it.kind === 'audio') {
      right.offset = edRound((it.offset || 0) + (t - it.start));
    }
    delete right.trans;
    it.dur = edRound(t - it.start);
    edProject.items.push(right);
    selected.add(right.id);
  });
  edSelected = selected;
  edCommit();
}

function edDetachAudio() {
  const it = edSelItem();
  if (!it || it.kind !== 'clip' || it.muted) return;
  const c = edClipOf(it);
  if (!c) return;
  edBegin();
  let a = edProject.tracks.find(t => t.type === 'audio');
  if (!a) {
    a = { id: edUid(), type: 'audio', label: 'A1' };
    edProject.tracks.push(a);
  }
  it.muted = true;
  const audio = edInsert({
    id: edUid(), kind: 'audio', trackId: a.id, clipId: it.clipId,
    start: it.start, dur: it.dur, offset: it.offset || 0, gain: edItemGain(it),
  });
  edSelectOnlyState(audio.id);
  edCommit();
}

function edDuplicateSel() {
  const bundle = edSelectionBundle();
  if (!bundle) return;
  const spanEnd = Math.max(...bundle.items.map(item => item.start + item.dur));
  const desiredDelta = spanEnd - bundle.origin + 0.25;
  const delta = edFindOpenGroupDelta(bundle.items, desiredDelta);
  edBegin();
  const copies = edCreateGroupCopies(bundle, delta);
  edProject.items.push(...copies);
  const primary = copies.find(item => item._sourceId === bundle.primaryId) || copies[0];
  copies.forEach(item => delete item._sourceId);
  edSetSelectionState(copies.map(item => item.id), primary.id, primary.id);
  edCommit();
}

function edCopySel() {
  const bundle = edSelectionBundle();
  if (bundle) edClipboard = bundle;
}

function edCutSel() {
  if (!edSelectionCount()) return;
  edCopySel();
  edDeleteSel();
}

function edPaste() {
  if (!edClipboard || !Array.isArray(edClipboard.items) || !edClipboard.items.length) return;
  const trackIds = new Set(edProject.tracks.map(track => track.id));
  if (edClipboard.items.some(item => !trackIds.has(item.trackId))) {
    toast('One or more copied tracks no longer exist', 'err');
    return;
  }
  const desiredDelta = edPlayhead - edClipboard.origin;
  const delta = edFindOpenGroupDelta(edClipboard.items, desiredDelta);
  edBegin();
  const copies = edCreateGroupCopies(edClipboard, delta);
  edProject.items.push(...copies);
  const primary = copies.find(item => item._sourceId === edClipboard.primaryId) || copies[0];
  copies.forEach(item => delete item._sourceId);
  edSetSelectionState(copies.map(item => item.id), primary.id, primary.id);
  edCommit();
}

function edDeleteSel() {
  if (!edSelectionCount()) return;
  const selected = new Set(edSelected);
  edBegin();
  edProject.items = edProject.items.filter(item => !selected.has(item.id));
  edSetSelectionState([]);
  edCommit();
}

function edRippleDeleteSel() {
  const removed = edSelectedItems().map(item => ({
    id: item.id,
    trackId: item.trackId,
    end: item.start + item.dur,
    dur: item.dur,
  }));
  if (!removed.length) return;
  const removedIds = new Set(removed.map(item => item.id));
  edBegin();
  edProject.items = edProject.items.filter(item => !removedIds.has(item.id));
  edProject.items.forEach(item => {
    const shift = removed.reduce((total, deleted) =>
      total + (deleted.trackId === item.trackId && deleted.end <= item.start + 0.001
        ? deleted.dur : 0), 0);
    if (shift > 0) item.start = edRound(Math.max(0, item.start - shift));
  });
  edSetSelectionState([]);
  edPlayhead = Math.min(edPlayhead, edEnd());
  edCommit();
}

function edSelectAll() {
  if (!edProject.items.length) return;
  const ids = edProject.items.map(item => item.id);
  edSetSelectionState(ids, ids[ids.length - 1], ids[ids.length - 1]);
  edSelectionChanged();
}

function edSeekEditPoint(direction) {
  const points = new Set([0, edEnd()]);
  edProject.items.forEach(item => {
    points.add(item.start);
    points.add(item.start + item.dur);
  });
  const ordered = [...points].sort((a, b) => a - b);
  const epsilon = 0.001;
  const target = direction < 0
    ? [...ordered].reverse().find(point => point < edPlayhead - epsilon)
    : ordered.find(point => point > edPlayhead + epsilon);
  if (target !== undefined) edSeek(target);
}

function edModKeyLabel() {
  return /Mac|iPhone|iPad/.test(navigator.platform) ? 'Cmd' : 'Ctrl';
}

function edOpenShortcutHelp() {
  document.querySelectorAll('[data-ed-mod]').forEach(element => {
    element.textContent = edModKeyLabel();
  });
  document.getElementById('ed-shortcuts-modal').classList.add('open');
}

function edCloseShortcutHelp() {
  document.getElementById('ed-shortcuts-modal').classList.remove('open');
}

function edShortcutHelpBackdrop(event) {
  if (event.target === event.currentTarget) edCloseShortcutHelp();
}

function edSelectionBundle() {
  const selected = edSelectedItems();
  if (!selected.length) return null;
  const selectedIds = new Set(selected.map(item => item.id));
  const items = selected.map(item => {
    const copy = JSON.parse(JSON.stringify(item));
    if (copy.trans) {
      const predecessor = edItems(item.trackId).filter(candidate =>
        candidate.kind === 'clip' && candidate.id !== item.id
        && Math.abs(candidate.start + candidate.dur - item.start) < 0.11).pop();
      if (predecessor && !selectedIds.has(predecessor.id)) delete copy.trans;
    }
    return copy;
  });
  return {
    items,
    origin: Math.min(...items.map(item => item.start)),
    primaryId: edSel,
  };
}

function edFindOpenGroupDelta(items, desiredDelta) {
  let delta = Math.max(-Math.min(...items.map(item => item.start)), desiredDelta);
  const occupied = edProject.items;
  for (let pass = 0; pass <= occupied.length * items.length; pass++) {
    let next = delta;
    items.forEach(item => {
      const start = item.start + delta;
      const end = start + item.dur;
      occupied.forEach(other => {
        if (other.trackId !== item.trackId) return;
        if (start < other.start + other.dur && end > other.start) {
          next = Math.max(next, other.start + other.dur - item.start);
        }
      });
    });
    if (Math.abs(next - delta) < 0.0005) return edRound(delta);
    delta = next;
  }
  return edRound(delta);
}

function edCreateGroupCopies(bundle, delta) {
  return bundle.items.map(source => Object.assign({}, JSON.parse(JSON.stringify(source)), {
    id: edUid(),
    start: edRound(source.start + delta),
    _sourceId: source.id,
  }));
}

function edGroupDeltaBounds(items) {
  const selectedIds = new Set(items.map(item => item.id));
  let min = -Math.min(...items.map(item => item.start));
  let max = Infinity;
  items.forEach(item => {
    let previousEnd = 0;
    let nextStart = Infinity;
    edProject.items.forEach(other => {
      if (other.trackId !== item.trackId || selectedIds.has(other.id)) return;
      const otherEnd = other.start + other.dur;
      if (otherEnd <= item.start + 0.001) previousEnd = Math.max(previousEnd, otherEnd);
      if (other.start >= item.start + item.dur - 0.001) {
        nextStart = Math.min(nextStart, other.start);
      }
    });
    min = Math.max(min, previousEnd - item.start);
    max = Math.min(max, nextStart - item.start - item.dur);
  });
  return {min, max};
}

function edSnapGroupDelta(delta, items) {
  const selectedIds = new Set(items.map(item => item.id));
  const targets = [0, edPlayhead];
  edProject.items.forEach(item => {
    if (!selectedIds.has(item.id)) targets.push(item.start, item.start + item.dur);
  });
  const edges = [];
  items.forEach(item => edges.push(item.start, item.start + item.dur));
  let best = delta;
  let distance = 8 / edPps;
  edges.forEach(edge => targets.forEach(target => {
    const candidate = target - edge;
    const gap = Math.abs(candidate - delta);
    if (gap < distance) {
      distance = gap;
      best = candidate;
    }
  }));
  return edRound(best);
}

function edAddTrack(type) {
  edBegin();
  const n = edProject.tracks.filter(t => t.type === type).length + 1;
  const nt = { id: edUid(), type, label: (type === 'video' ? 'V' : 'A') + n };
  if (type === 'audio') {
    edProject.tracks.push(nt);
  } else {
    const idx = edProject.tracks.findIndex(t => t.type === 'video');
    edProject.tracks.splice(idx === -1 ? edProject.tracks.length : idx, 0, nt);
  }
  edCommit();
}

function edRemoveTrack(id) {
  const tr = edProject.tracks.find(t => t.id === id);
  if (!tr || tr.type === 'text') return;
  if (tr.type === 'video' && edVideoTracks().length <= 1) return;
  edBegin();
  edProject.tracks = edProject.tracks.filter(t => t.id !== id);
  edProject.items = edProject.items.filter(i => i.trackId !== id);
  edReconcileSelection();
  edCommit();
}

function edReset() {
  edBegin();
  edProject = edDefaultProject();
  edSetSelectionState([]);
  edPlayhead = 0;
  edSetPlaying(false);
  edMissing = new Set();
  edCommit();
}

// A clip vanished (deleted elsewhere); the server already migrated the
// stored project, mirror it locally without spawning an undo entry.
function edOnClipDeleted(slug) {
  if (!edProject) return;
  const before = edProject.items.length;
  edProject.items = edProject.items.filter(i => i.clipId !== slug);
  edReconcileSelection();
  edRefreshMissing();
  if (before !== edProject.items.length && currentView === 'editor') {
    if (edReconcileProjectResolution(true)) edScheduleSave();
    edSyncResolutionControls();
    edRenderTimeline();
    edRenderPreviewFrame(true);
  }
}

// The server rewrote the stored project (rename migration): reload it, but
// never while the user has unsaved local changes in flight.
async function edOnProjectChanged() {
  if (!edLoaded || edDirty) return;
  await edLoad();
  if (currentView === 'editor') {
    edReconcileSelection();
    edSyncResolutionControls();
    edRenderTimeline();
    edRenderPreviewFrame(true);
  }
}

// ═══════════════════════════════════════════════════════════════════
// View enter / leave + keyboard
// ═══════════════════════════════════════════════════════════════════
async function editorEnter() {
  document.querySelector('.stage').classList.add('stage-editor');
  document.getElementById('quit-row')?.classList.add('ed-hidden');
  edInitPanels();
  edInitTimeline();
  if (!edLoaded) await edLoad();
  edRefreshMissing();
  if (edReconcileProjectResolution(true)) edScheduleSave();
  edSyncResolutionControls();
  edRenderLibrary();
  edRenderTimeline();
  edRenderPreviewFrame(true);
}

function editorLeave() {
  document.querySelector('.stage').classList.remove('stage-editor');
  document.getElementById('quit-row')?.classList.remove('ed-hidden');
  edSetPlaying(false);
  if (edDirty) edSaveNow();
}

// The clip list refreshed (startup fetch or a live save). The library and
// the missing-clip styling must follow, or an editor opened before the
// first /api/clips response stays empty forever.
function edOnClipsRefreshed() {
  if (!edLoaded || currentView !== 'editor') return;
  edRefreshMissing();
  if (edReconcileProjectResolution(true)) edScheduleSave();
  edSyncResolutionControls();
  edRenderLibrary();
  edRenderTimeline();
  edRenderPreviewFrame(true);
}

function edKeydown(e) {
  if (currentView !== 'editor' || !edProject) return;
  const shortcutHelp = document.getElementById('ed-shortcuts-modal');
  if (shortcutHelp.classList.contains('open')) {
    if (e.key === 'Escape' || e.key === '?') {
      e.preventDefault();
      edCloseShortcutHelp();
    }
    return;
  }
  const gainPopover = document.getElementById('ed-gain-popover');
  if (!gainPopover.hidden) {
    if (e.key === 'Escape') {
      e.preventDefault();
      edCloseGainPopover();
    }
    return;
  }
  const itemMenu = document.getElementById('ed-menu');
  if (itemMenu) {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (typeof edMenuDismiss === 'function' && edMenuDismiss) edMenuDismiss();
    }
    return;
  }
  const tg = e.target;
  if (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.tagName === 'SELECT'
      || tg.isContentEditable) return;
  if (document.querySelector('.backdrop.open')) return;
  const mod = e.metaKey || e.ctrlKey;
  if (e.code === 'Space') { e.preventDefault(); edSetPlaying(!edPlaying); }
  else if (e.shiftKey && (e.key === 'Delete' || e.key === 'Backspace')) {
    e.preventDefault(); edRippleDeleteSel();
  }
  else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); edDeleteSel(); }
  else if (mod && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); edUndo(); }
  else if (mod && e.shiftKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); edRedo(); }
  else if (mod && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); edSelectAll(); }
  else if (mod && (e.key === 'x' || e.key === 'X')) { e.preventDefault(); edCutSel(); }
  else if (mod && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); edCopySel(); }
  else if (mod && (e.key === 'v' || e.key === 'V')) { e.preventDefault(); edPaste(); }
  else if (mod && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); edDuplicateSel(); }
  else if (!mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); edSplitSel(); }
  else if (!mod && e.key === 'ArrowLeft') {
    e.preventDefault();
    edSeek(Math.max(0, edPlayhead - (e.shiftKey ? 1 : 1 / edOutputFps())));
  }
  else if (!mod && e.key === 'ArrowRight') {
    e.preventDefault();
    edSeek(Math.min(edEnd(), edPlayhead + (e.shiftKey ? 1 : 1 / edOutputFps())));
  }
  else if (!mod && e.key === 'ArrowUp') { e.preventDefault(); edSeekEditPoint(-1); }
  else if (!mod && e.key === 'ArrowDown') { e.preventDefault(); edSeekEditPoint(1); }
  else if (!mod && e.key === 'Home') { e.preventDefault(); edSeek(0); }
  else if (!mod && e.key === 'End') { e.preventDefault(); edSeek(edEnd()); }
  else if (!mod && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); edFit(); }
  else if (!mod && e.key === '?') { e.preventDefault(); edOpenShortcutHelp(); }
  else if (e.key === 'Escape') { e.preventDefault(); edClearSelection(); }
  else if (!mod && (e.key === '+' || e.key === '=')) { e.preventDefault(); edZoom(1.3); }
  else if (!mod && e.key === '-') { e.preventDefault(); edZoom(1 / 1.3); }
}
document.addEventListener('keydown', edKeydown);

function edSelect(id) {
  edSelectOnlyState(id);
  edSelectionChanged();
}

function edMakePrimary(id) {
  if (!edIsSelected(id)) {
    edSelect(id);
    return;
  }
  edSel = id;
  edSelectionChanged();
}

function edTimelineSelect(id, event) {
  const item = edItem(id);
  if (!item) return;
  const mod = Boolean(event && (event.metaKey || event.ctrlKey));
  const shift = Boolean(event && event.shiftKey);

  if (shift) {
    const anchor = edItem(edRangeAnchor);
    if (!anchor || anchor.trackId !== item.trackId) {
      edSelect(id);
      return;
    }
    const lane = edItems(item.trackId);
    const from = lane.findIndex(candidate => candidate.id === anchor.id);
    const to = lane.findIndex(candidate => candidate.id === item.id);
    if (from < 0 || to < 0) {
      edSelect(id);
      return;
    }
    const range = lane.slice(Math.min(from, to), Math.max(from, to) + 1);
    const next = mod ? new Set(edSelected) : new Set();
    range.forEach(candidate => next.add(candidate.id));
    edSelected = next;
    edSel = id;
    edSelectionChanged();
    return;
  }

  if (mod) {
    if (edSelected.has(id)) {
      edSelected.delete(id);
      const promoted = edLastSelectedId();
      if (edSel === id) edSel = promoted;
      if (edRangeAnchor === id) edRangeAnchor = promoted;
    } else {
      edSelected.add(id);
      edSel = id;
      edRangeAnchor = id;
    }
    edSelectionChanged();
    return;
  }

  edSelect(id);
}

function edClearSelection() {
  edSetSelectionState([]);
  edSelectionChanged();
}

function edSelectionChanged() {
  if (typeof edCloseGainPopover === 'function') edCloseGainPopover();
  edRenderTimelineSelection();
  edRenderInspector();
}

// ═══════════════════════════════════════════════════════════════════
// Panel resizers (pointer capture, like the trim handles)
// ═══════════════════════════════════════════════════════════════════
let edPanelsWired = false;

function edInitPanels() {
  if (edPanelsWired) return;
  edPanelsWired = true;
  const view = document.getElementById('view-editor');
  const state = { libW: Math.max(240, Math.min(324, Math.round(window.innerWidth * 0.22))), tlH: 300 };
  const apply = () => {
    view.style.setProperty('--ed-lib-w', state.libW + 'px');
    view.style.setProperty('--ed-tl-h', state.tlH + 'px');
  };
  apply();

  const wire = (id, horizontal) => {
    const el = document.getElementById(id);
    el.addEventListener('pointerdown', e => {
      e.preventDefault();
      edCapture(el, e);
      const s = horizontal ? e.clientX : e.clientY;
      const base = horizontal ? state.libW : state.tlH;
      const mv = ev => {
        const d = (horizontal ? ev.clientX : ev.clientY) - s;
        if (horizontal) state.libW = Math.max(232, Math.min(520, base + d));
        else state.tlH = Math.max(170, Math.min(Math.round(view.clientHeight * 0.7), base - d));
        apply();
      };
      const up = () => {
        el.removeEventListener('pointermove', mv);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        el.removeEventListener('lostpointercapture', up);
        edRenderTimeline();
      };
      el.addEventListener('pointermove', mv);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('lostpointercapture', up);
    });
  };
  wire('ed-rsz-h', true);
  wire('ed-rsz-v', false);
}
