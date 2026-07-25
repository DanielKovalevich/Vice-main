'use strict';
// home.js — home view population (greeting, dynamic copy, recent clips)

// ═══════════════════════════════════════════════════════════════════
// Home population — uses cfg + runtime status
// ═══════════════════════════════════════════════════════════════════
// Pretty names for evdev key tokens so a combo like
// "LEFTALT+KEY_LEFTSHIFT+KEY_Z" reads as "Alt + Shift + Z" instead of the raw
// kernel names, which look terrible in the UI (banner, tutorial, toasts).
const HOTKEY_MODS = {
  LEFTCTRL: 'Ctrl', RIGHTCTRL: 'Ctrl', LEFTALT: 'Alt', RIGHTALT: 'Alt',
  LEFTSHIFT: 'Shift', RIGHTSHIFT: 'Shift', LEFTMETA: 'Super', RIGHTMETA: 'Super',
};
const HOTKEY_SPECIAL = {
  SPACE: 'Space', ENTER: 'Enter', ESC: 'Esc', TAB: 'Tab', BACKSPACE: 'Bksp',
  DELETE: 'Del', INSERT: 'Ins', HOME: 'Home', END: 'End',
  PAGEUP: 'PgUp', PAGEDOWN: 'PgDn', UP: '\u2191', DOWN: '\u2193',
  LEFT: '\u2190', RIGHT: '\u2192', GRAVE: '`', MINUS: '-', EQUAL: '=',
  LEFTBRACE: '[', RIGHTBRACE: ']', BACKSLASH: '\\', SEMICOLON: ';',
  APOSTROPHE: '\'', COMMA: ',', DOT: '.', SLASH: '/',
};

function formatKeyToken(token) {
  const t = String(token || '').replace(/^KEY_/, '');
  if (!t) return '';
  if (HOTKEY_MODS[t]) return HOTKEY_MODS[t];
  if (HOTKEY_SPECIAL[t]) return HOTKEY_SPECIAL[t];
  if (/^KP/.test(t)) return 'Num ' + t.slice(2);
  return t;
}

// Turn an evdev clip combo into a readable label, modifiers first.
function formatHotkey(combo) {
  const parts = String(combo || 'KEY_F9').split('+').map(formatKeyToken).filter(Boolean);
  const order = ['Ctrl', 'Alt', 'Shift', 'Super'];
  parts.sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    if (ia === -1 && ib === -1) return 0;
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
  return parts.join(' + ') || 'F9';
}

function hotkeyLabel() {
  return formatHotkey(cfg.hotkeys?.clip || 'KEY_F9');
}

function renderGreeting() {
  const hour = new Date().getHours();
  const period = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  setText('home-greeting', period);
}

function syncDynamicCopy() {
  const key = hotkeyLabel();
  const dur = cfg.recording?.clip_duration ?? 20;

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

// How many cards fit on one row of a home clip strip at the current window
// width. Mirrors the grid's minmax(240px, 1fr) with its 14px gap.
function homeRowCapacity() {
  const row = document.getElementById('home-clip-row');
  const width = row ? row.clientWidth : 0;
  if (!width) return 4;
  return Math.max(1, Math.floor((width + 14) / (240 + 14)));
}

function fillClipRow(row, list) {
  row.innerHTML = '';
  list.forEach((c, i) => {
    const card = document.createElement('div');
    card.innerHTML = cardHTML(c).trim();
    const node = card.firstChild;
    node.style.animationDelay = (i * 60) + 'ms';
    row.appendChild(node);
  });
  // Home cards share ids with grid cards; hover previews resolve per card
  // element, and each render needs the decode-failure fallback (issue #79).
  attachPreviewFailureHandlers(row);
}

function renderHomeRecent() {
  const row = document.getElementById('home-clip-row');
  if (!clips.length) {
    row.innerHTML = `<div class="home-empty">No clips yet. Press ${escHtml(hotkeyLabel())} to start your reel.</div>`;
    return;
  }
  fillClipRow(row, clips.slice(0, homeRowCapacity()));
}

function renderMostViewed() {
  const section = document.getElementById('home-viewed-section');
  const viewed = clips
    .filter(c => (c.views || 0) > 0)
    .sort((a, b) => (b.views || 0) - (a.views || 0))
    .slice(0, homeRowCapacity());
  section.style.display = viewed.length ? '' : 'none';
  fillClipRow(document.getElementById('home-viewed-row'), viewed);
}

let _homeResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(_homeResizeTimer);
  _homeResizeTimer = setTimeout(() => {
    renderHomeRecent();
    renderMostViewed();
  }, 150);
});
