'use strict';
// status.js — recording status chip + session timer

// ═══════════════════════════════════════════════════════════════════
// Recording status + session timer
// ═══════════════════════════════════════════════════════════════════
let _sessionTimerInterval = null;
let _sessionStartTs = 0;

function setDetectedGame(game) {
  const card = document.getElementById('side-game-status');
  if (!card) return;
  const name = typeof game === 'string' ? game.trim() : '';
  card.hidden = !name;
  setText('side-game-readout', name);
}

async function refreshDetectedGame() {
  try {
    const r = await fetch('/api/status');
    const d = await r.json();
    setDetectedGame(d.game);
  } catch (_) {}
}

function setRecStatus(live, backend, sessionActive, waitingForGame = false) {
  runtimeBackend = backend || runtimeBackend;
  const chip = document.getElementById('rec-chip');
  const dot  = document.getElementById('rec-dot');
  const lbl  = document.getElementById('rec-lbl');
  const side = document.getElementById('side-buffer-status');
  const sideTitle = document.getElementById('side-buffer-title');
  const waiting = waitingForGame === true && !live;

  dot.classList.remove('live', 'session');
  chip.classList.remove('timing');

  if (sessionActive) {
    dot.classList.add('session');
    lbl.textContent = 'Session';
    chip.classList.add('timing');
    _sessionStartTs = _sessionStartTs || Date.now();
    clearInterval(_sessionTimerInterval);
    _sessionTimerInterval = setInterval(() => {
      const e = Math.floor((Date.now() - _sessionStartTs) / 1000);
      document.getElementById('session-elapsed').textContent =
        `${Math.floor(e/60)}:${String(e%60).padStart(2,'0')}`;
    }, 1000);
  } else if (live) {
    dot.classList.add('live');
    lbl.textContent = (backend || 'Live').replace('Recorder','').trim() || 'Live';
    clearSessionTimer();
  } else {
    lbl.textContent = waiting ? 'Waiting' : 'Idle';
    clearSessionTimer();
  }
  if (side) side.classList.toggle('waiting', waiting);
  if (sideTitle) {
    sideTitle.textContent = live ? 'Buffer live' : (waiting ? 'Waiting for game' : 'Buffer idle');
  }
  setText('about-backend', runtimeBackend || 'auto');
  setText('side-buffer-readout', bufferReadout());
}

function clearSessionTimer() {
  clearInterval(_sessionTimerInterval);
  _sessionTimerInterval = null;
  _sessionStartTs = 0;
  document.getElementById('session-elapsed').textContent = '0:00';
}

function flashRecSaving() {
  const dot = document.getElementById('rec-dot');
  const lbl = document.getElementById('rec-lbl');
  const prev = lbl.textContent;
  dot.classList.add('live');
  lbl.textContent = 'Saving…';
  setTimeout(() => {
    dot.classList.remove('live');
    lbl.textContent = prev || 'Idle';
  }, 1200);
}

async function fetchStatus() {
  try {
    const r = await fetch('/api/status');
    const d = await r.json();
    runtimeBackend = d.backend || runtimeBackend;
    if (d.version) viceVersion = d.version;
    setRecStatus(d.recording, d.backend, d.session_active, d.waiting_for_game);
    setDetectedGame(d.game);
    applyHotkeyAvailability(d.hotkeys_available);
    // The daily check may have already run before this window opened.
    if (d.update && typeof onUpdateAvailable === 'function') {
      onUpdateAvailable(d.update, { delay: 1200 });
    }
    if (d.public_url) {
      tunnelUrl = d.public_url;
      const ro = document.getElementById('tunnel-readout');
      const rt = document.getElementById('tunnel-readout-text');
      rt.textContent = d.public_url;
      ro.classList.add('active');
    }
  } catch (_) {}
}

function applyHotkeyAvailability(available) {
  hotkeysAvailable = available !== false;
  const warn = document.getElementById('hotkey-perm-warning');
  if (warn) warn.classList.toggle('show', !hotkeysAvailable);
}
