'use strict';
// home.js — home view population (hero, stats, recent clips)

// ═══════════════════════════════════════════════════════════════════
// Home population — uses cfg + runtime status
// ═══════════════════════════════════════════════════════════════════
// The bars animate via a pure CSS transform keyframe (see home.css) instead
// of a JS timer mutating heights: a perpetual 500 ms style-mutation loop kept
// the renderer compositing forever and leaked GPU/renderer memory while the
// window sat open (#83). scaleY runs on the compositor and costs ~nothing,
// and pausing is a single class toggle.
function populateBufferViz() {
  const viz = document.getElementById('buffer-viz');
  if (!viz || viz.children.length) return;  // already built
  for (let i = 0; i < 48; i++) {
    const b = document.createElement('div');
    b.className = 'buffer-bar';
    const base = (34 + Math.sin(i * 0.4) * 20 + Math.random() * 28) / 60;
    b.style.setProperty('--s1', Math.max(0.13, Math.min(1, base)).toFixed(3));
    b.style.setProperty('--s2', Math.max(0.13, Math.min(1, base + (Math.random() - 0.5) * 0.6)).toFixed(3));
    b.style.setProperty('--s3', Math.max(0.13, Math.min(1, base + (Math.random() - 0.5) * 0.6)).toFixed(3));
    b.style.animationDuration = (2.2 + Math.random() * 1.8).toFixed(2) + 's';
    b.style.animationDelay = (-Math.random() * 4).toFixed(2) + 's';
    viz.appendChild(b);
  }
}

function startBufferViz() {
  const viz = document.getElementById('buffer-viz');
  if (viz) viz.classList.remove('viz-paused');
}

function stopBufferViz() {
  const viz = document.getElementById('buffer-viz');
  if (viz) viz.classList.add('viz-paused');
}

function hotkeyLabel() {
  return (cfg.hotkeys?.clip || 'KEY_F9').replace(/^KEY_/, '');
}

function syncDynamicCopy() {
  const key = hotkeyLabel();
  const dur = cfg.recording?.clip_duration ?? 15;

  setText('lede-key', key);
  setText('lede-dur', dur + 's');
  setText('qk-key', key);
  setText('qk-key-double', `${key} · ${key}`);
  setText('stat-key', key);
  setText('tut-key-1', key);
  setText('tut-key-2', `\u00b7${key}\u00b7`);
  setText('tut-title-1', `Save the last ${dur}s`);
  setText('tut-body-1', `Press ${key} after something worth keeping.`);
  setText('tut-title-2', `Double-tap ${key} for a session`);
  setText('tut-body-2', `Double-tap ${key} to start or stop a full recording. Tap once during a session to mark a highlight.`);

  const empty = document.getElementById('empty-hint');
  if (empty) {
    empty.innerHTML = `Press <span class="kbd inline-kbd">${escHtml(key)}</span> to save the last ${dur} seconds. Double-tap to start a session recording.`;
  }
}

function populateHomeFromCfg() {
  const r = cfg.recording || {}, o = cfg.output || {};
  setText('hero-backend', runtimeBackend || r.backend || 'auto');
  setText('hero-dur', fmtSec(r.clip_duration ?? 15));
  setText('hero-dir', o.directory ?? '~/Videos/Vice');
  // Card is titled "Rolling buffer" — describe the actual rolling buffer, not the clip window
  // (clip duration has its own row below).
  setText('hero-buf-readout', `${fmtSec(r.buffer_duration ?? 120)} rolling · ${r.fps ?? 60} fps`);
  setText('about-backend', runtimeBackend || r.backend || 'auto');
  setText('about-buffer', (r.buffer_duration ?? 120) + ' s');
  setText('about-fps', (r.fps ?? 60) + ' fps');
  syncDynamicCopy();
}

function renderStats() {
  setText('stat-count', clips.length);
  const total = clips.reduce((s,c) => s + (c.duration || 0), 0);
  const size  = clips.reduce((s,c) => s + (c.size || 0), 0);
  setText('stat-total-dur',
    total < 60 ? `${Math.round(total)}s` : `${Math.floor(total/60)}:${String(Math.floor(total%60)).padStart(2,'0')}`);
  setText('stat-size', `${(size / 1048576).toFixed(0)} MB`);
}

function renderHomeRecent() {
  const row = document.getElementById('home-clip-row');
  if (!clips.length) {
    row.innerHTML = `<div class="home-empty">No clips yet. Press ${escHtml(hotkeyLabel())} to start your reel.</div>`;
    return;
  }
  row.innerHTML = '';
  clips.slice(0, 4).forEach((c, i) => {
    const card = document.createElement('div');
    card.innerHTML = cardHTML(c).trim();
    const node = card.firstChild;
    node.style.animationDelay = (i * 60) + 'ms';
    row.appendChild(node);
  });
}
