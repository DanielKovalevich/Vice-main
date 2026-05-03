'use strict';
// home.js — home view population (hero, stats, recent clips)

// ═══════════════════════════════════════════════════════════════════
// Home population — uses cfg + runtime status
// ═══════════════════════════════════════════════════════════════════
let _bufferVizTimer = null;
function populateBufferViz() {
  const viz = document.getElementById('buffer-viz');
  if (viz.children.length) return;  // already built
  for (let i = 0; i < 48; i++) {
    const b = document.createElement('div');
    b.className = 'buffer-bar';
    const h = 14 + Math.sin(i * 0.4) * 20 + Math.random() * 28;
    b.style.height = Math.max(8, Math.min(60, h)) + 'px';
    b.style.animationDelay = (i * 20) + 'ms';
    viz.appendChild(b);
  }
  startBufferViz();
}

function startBufferViz() {
  if (_bufferVizTimer) return;
  const viz = document.getElementById('buffer-viz');
  if (!viz) return;
  _bufferVizTimer = setInterval(() => {
    [...viz.children].forEach((b, i) => {
      const h = 14 + Math.sin((Date.now()/300 + i * 0.4)) * 20 + Math.random() * 20;
      b.style.height = Math.max(8, Math.min(60, h)) + 'px';
    });
  }, 500);
}

function stopBufferViz() {
  if (!_bufferVizTimer) return;
  clearInterval(_bufferVizTimer);
  _bufferVizTimer = null;
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
