'use strict';
// editor-export.js — export modal (progress over WS) + reset confirm

let edExportJob = null;      // job_id while a render runs
let edExportPhase = 'form';  // form | busy | done
const ED_EXPORT_SHORT_EDGES = [2160, 1440, 1080, 720];
const ED_EXPORT_FPS_VALUES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 120, 144];

function edExportPresetResolutions(viewport) {
  const seen = new Set([edResolutionValue(viewport)]);
  const values = [];
  ED_EXPORT_SHORT_EDGES.forEach(shortEdge => {
    const landscape = viewport.width >= viewport.height;
    const candidate = landscape
      ? {
          width: Math.round((shortEdge * viewport.width / viewport.height) / 2) * 2,
          height: shortEdge,
        }
      : {
          width: shortEdge,
          height: Math.round((shortEdge * viewport.height / viewport.width) / 2) * 2,
        };
    const resolution = edNormalizeResolution(candidate);
    const value = edResolutionValue(resolution);
    if (!resolution || seen.has(value) || !edSameAspect(viewport, resolution)) return;
    seen.add(value);
    values.push(resolution);
  });
  return values;
}

function edSyncExportResolutionControl() {
  const select = document.getElementById('ed-export-res');
  if (!select || !edProject) return;
  const viewport = edViewportResolution();
  select.innerHTML = '';
  select.add(new Option(
    `Match canvas · ${viewport.width} × ${viewport.height}`,
    'match',
  ));
  edExportPresetResolutions(viewport).forEach(resolution => {
    select.add(new Option(
      `${resolution.width} × ${resolution.height}`,
      edResolutionValue(resolution),
    ));
  });

  const configured = edNormalizeResolution(edProject.export);
  let value = 'match';
  if (configured && edSameAspect(viewport, configured)) {
    value = edResolutionValue(configured);
    if (![...select.options].some(option => option.value === value)) {
      select.add(new Option(
        `${configured.width} × ${configured.height}`,
        value,
      ));
    }
  }
  select.value = value;
}

function edExportResolutionChanged(value) {
  if (!edProject) return;
  const viewport = edViewportResolution();
  const next = value === 'match' ? null : edResolutionFromValue(value);
  if (value !== 'match' && (!next || !edSameAspect(viewport, next))) {
    edSyncExportResolutionControl();
    toast('Export resolution must match the canvas aspect ratio', 'err');
    return;
  }
  edBegin();
  if (next) edProject.export = next;
  else delete edProject.export;
  edCommit();
  edExportSummary();
}

function edSyncExportFpsControl() {
  const select = document.getElementById('ed-export-fps');
  if (!select || !edProject) return;
  const automatic = edSourceFps();
  select.innerHTML = '';
  select.add(new Option(`Auto · ${edFormatFps(automatic)} fps`, 'auto'));
  ED_EXPORT_FPS_VALUES.forEach(fps => {
    select.add(new Option(`${edFormatFps(fps)} fps`, String(fps)));
  });
  const configured = edNormalizeFps(edProject.fps);
  if (configured) {
    const value = String(configured);
    if (![...select.options].some(option => option.value === value)) {
      select.add(new Option(`${edFormatFps(configured)} fps`, value));
    }
    select.value = value;
  } else {
    select.value = 'auto';
  }
}

function edExportFpsChanged(value) {
  if (!edProject) return;
  const next = value === 'auto' ? null : edNormalizeFps(value);
  if (value !== 'auto' && !next) {
    edSyncExportFpsControl();
    toast('Export FPS must be between 1 and 240', 'err');
    return;
  }
  const current = edNormalizeFps(edProject.fps);
  if ((!current && !next) || (current && next && current === next)) return;
  edBegin();
  if (next) edProject.fps = next;
  else delete edProject.fps;
  edCommit();
  edExportSummary();
}

function edOpenExport() {
  if (edEnd() <= 0) { toast('The timeline is empty', 'err'); return; }
  edSetPlaying(false);
  if (edReconcileProjectResolution(true)) edScheduleSave();
  edExportPhase = 'form';
  document.getElementById('ed-export-name').value = '';
  document.getElementById('ed-export-loc').value = 'library';
  document.getElementById('ed-export-custom').value = '';
  document.getElementById('ed-export-add').checked = true;
  edSyncExportResolutionControl();
  edSyncExportFpsControl();
  edSyncExportGameControl();
  edExportLocChanged();
  edExportShowPhase();
  document.getElementById('ed-export-modal').classList.add('open');
}

function edCloseExport() {
  if (edExportPhase === 'busy') return;
  document.getElementById('ed-export-modal').classList.remove('open');
}

// Distinct games of the clips referenced by the current project's timeline.
function edProjectSourceGames() {
  const out = [];
  if (!edProject || !Array.isArray(edProject.items)) return out;
  const seen = new Set();
  edProject.items.forEach(it => {
    if (it.kind !== 'clip' || !it.clipId || seen.has(it.clipId)) return;
    seen.add(it.clipId);
    const c = clips.find(x => x.slug === it.clipId);
    if (c && c.game) out.push(c.game);
  });
  return out;
}

// Pre-fill the export game the same way the backend infers it: the shared game
// when every tagged source agrees, "Multiple games" when they disagree, and no
// game (blank) when none are tagged.
function edInferExportGame() {
  const distinct = [...new Set(edProjectSourceGames())];
  if (distinct.length === 1) return distinct[0];
  if (distinct.length > 1) return 'Multiple games';
  return '';
}

// One shared game picker (same option list as the Configure-metadata modal),
// pre-filled from the project's sources.
function edSyncExportGameControl() {
  const input = document.getElementById('ed-export-game');
  if (!input) return;
  const list = document.getElementById('ed-export-games');
  if (list) {
    const opts = new Set(edProjectSourceGames());
    opts.add('Multiple games');
    if (typeof gameOptionsHTML === 'function') {
      list.innerHTML = gameOptionsHTML();
    } else {
      list.innerHTML = [...opts]
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
        .map(g => `<option value="${escAttr(g)}"></option>`).join('');
    }
  }
  input.value = edInferExportGame();
}

function edExportBackdrop(e) {
  if (e.target === e.currentTarget) edCloseExport();
}

function edExportLocChanged() {
  const loc = document.getElementById('ed-export-loc').value;
  document.getElementById('ed-export-custom-field').hidden = loc !== 'custom';
  document.getElementById('ed-export-also').hidden = loc === 'library';
  edExportSummary();
}

function edExportSummary() {
  const loc = document.getElementById('ed-export-loc').value;
  const name = document.getElementById('ed-export-name').value.trim() || 'Vice_Edit_N';
  const dir = loc === 'library' ? (cfg.output?.directory || '~/Videos/Vice')
    : loc === 'videos' ? '~/Videos'
    : (document.getElementById('ed-export-custom').value.trim() || '…');
  const resolution = edExportResolution();
  const fps = edOutputFps();
  setText('ed-export-summary',
    `${edFmtS(edEnd())} · ${resolution.width}×${resolution.height} · ${edFormatFps(fps)} fps · H.264 + AAC → ${dir}/${name.replace(/\.mp4$/i, '')}.mp4`);
  const warnEl = document.getElementById('ed-export-warn');
  const status = document.getElementById('rec-lbl');
  warnEl.hidden = !(status && /recording|session/i.test(status.textContent || ''));
}

function edExportShowPhase() {
  document.getElementById('ed-export-form').hidden = edExportPhase !== 'form';
  document.getElementById('ed-export-busy').hidden = edExportPhase !== 'busy';
  document.getElementById('ed-export-done').hidden = edExportPhase !== 'done';
  document.getElementById('ed-export-ft-form').hidden = edExportPhase !== 'form';
  document.getElementById('ed-export-ft-busy').hidden = edExportPhase !== 'busy';
  document.getElementById('ed-export-ft-done').hidden = edExportPhase !== 'done';
}

async function edStartExport() {
  const loc = document.getElementById('ed-export-loc').value;
  const name = document.getElementById('ed-export-name').value.trim();
  const custom = document.getElementById('ed-export-custom').value.trim();
  if (loc === 'custom' && !custom) { toast('Pick a folder for the export', 'err'); return; }
  if (edReconcileProjectResolution(true)) edScheduleSave();
  if (edDirty && !(await edSaveNow())) return;

  const body = {
    project: edProject,
    location: loc,
    add_to_library: document.getElementById('ed-export-add').checked,
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#0099ff',
  };
  if (name) body.filename = name;
  if (loc === 'custom') body.path = custom;
  // Always send the picker's choice (even blank = "No game") so the backend
  // records it verbatim instead of re-inferring a game from the sources.
  body.game = document.getElementById('ed-export-game').value.trim();

  try {
    const r = await fetch('/api/editor/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!d.ok) {
      const msg = d.error || (d.errors && d.errors[0]) || 'Export failed';
      toast(msg, 'err');
      return;
    }
    edExportJob = d.job_id;
    edExportPhase = 'busy';
    document.getElementById('ed-progress-fill').style.width = '0%';
    setText('ed-progress-label', '0% · encoding H.264');
    setText('ed-export-done-path', d.path);
    edExportShowPhase();
  } catch (_) { toast('Export failed, daemon unreachable', 'err'); }
}

async function edCancelExport() {
  if (!edExportJob) return;
  try {
    await fetch(`/api/editor/export/${encodeURIComponent(edExportJob)}/cancel`, { method: 'POST' });
  } catch (_) {}
}

function edOnExportProgress(msg) {
  if (msg.job_id !== edExportJob) return;
  const pct = Math.min(100, Math.round((msg.progress || 0) * 100));
  document.getElementById('ed-progress-fill').style.width = pct + '%';
  setText('ed-progress-label', `${pct}% · encoding H.264`);
}

function edOnExportDone(msg) {
  if (msg.job_id !== edExportJob) return;
  edExportJob = null;
  edExportPhase = 'done';
  setText('ed-export-done-path', msg.path || '');
  edExportShowPhase();
}

function edOnExportError(msg) {
  if (msg.job_id !== edExportJob) return;
  edExportJob = null;
  edExportPhase = 'form';
  edExportShowPhase();
  toast(msg.canceled ? 'Export canceled' : (msg.error || 'Export failed'), msg.canceled ? 'ok' : 'err');
}

// ── Reset confirm ──
function edOpenReset() {
  edSetPlaying(false);
  document.getElementById('ed-reset-modal').classList.add('open');
}

function edCloseReset() {
  document.getElementById('ed-reset-modal').classList.remove('open');
}

function edConfirmReset() {
  edCloseReset();
  edReset();
}
