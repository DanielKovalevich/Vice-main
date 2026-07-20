'use strict';
// home.js — home view population (greeting, dynamic copy, recent clips)

// ═══════════════════════════════════════════════════════════════════
// Home population — uses cfg + runtime status
// ═══════════════════════════════════════════════════════════════════
function hotkeyLabel() {
  return (cfg.hotkeys?.clip || 'KEY_F9').replace(/^KEY_/, '');
}

function renderGreeting() {
  const hour = new Date().getHours();
  const period = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  setText('home-greeting', period);
}

function syncDynamicCopy() {
  const key = hotkeyLabel();
  const dur = cfg.recording?.clip_duration ?? 15;

  setText('lede-key', key);
  setText('lede-dur', dur + 's');
  setText('tut-key-1', key);
  setText('tut-key-2', `·${key}·`);
  setText('tut-title-1', `Save the last ${dur}s`);
  setText('tut-body-1', `Press ${key} after something worth keeping.`);
  setText('tut-title-2', `Double-tap ${key} for a session`);
  setText('tut-body-2', `Double-tap ${key} to start or stop a full recording. Tap once during a session to mark a highlight.`);

  const empty = document.getElementById('empty-hint');
  if (empty && !currentPlaylistId && !searchQuery.trim()) {
    empty.innerHTML = `Press <span class="kbd inline-kbd">${escHtml(key)}</span> to save the last ${dur} seconds. Double-tap to start a session recording.`;
  }
}

function bufferReadout() {
  const r = cfg.recording || {};
  const backend = runtimeBackend || r.backend || 'auto';
  return `${fmtSec(r.buffer_duration ?? 120)} · ${r.fps ?? 60} fps · ${backend}`;
}

function populateHomeFromCfg() {
  const r = cfg.recording || {};
  renderGreeting();
  setText('side-buffer-readout', bufferReadout());
  setText('about-backend', runtimeBackend || r.backend || 'auto');
  setText('about-buffer', (r.buffer_duration ?? 120) + ' s');
  setText('about-fps', (r.fps ?? 60) + ' fps');
  syncDynamicCopy();
}

function renderStats() {
  const total = clips.reduce((s,c) => s + (c.duration || 0), 0);
  const size  = clips.reduce((s,c) => s + (c.size || 0), 0);
  const footage = total < 60
    ? `${Math.round(total)}s`
    : `${Math.floor(total/60)}:${String(Math.floor(total%60)).padStart(2,'0')}`;
  setText('about-clips', `${clips.length} · ${(size / 1073741824).toFixed(1)} GB`);
  setText('about-footage', footage);
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
  // Home cards share ids with grid cards, and getElementById resolves to
  // these first, so hover previews actually play here. They need the same
  // decode-failure fallback as the grid (issue #79).
  attachPreviewFailureHandlers(row);
}
