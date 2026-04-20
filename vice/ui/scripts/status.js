'use strict';
// status.js — recording status chip + session timer

// ═══════════════════════════════════════════════════════════════════
// Recording status + session timer
// ═══════════════════════════════════════════════════════════════════
let _sessionTimerInterval = null;
let _sessionStartTs = 0;

function setRecStatus(live, backend, sessionActive) {
  runtimeBackend = backend || runtimeBackend;
  const chip = document.getElementById('rec-chip');
  const dot  = document.getElementById('rec-dot');
  const lbl  = document.getElementById('rec-lbl');
  const hd   = document.getElementById('hero-dot');
  const ht   = document.getElementById('hero-status-text');

  dot.classList.remove('live', 'session');
  if (hd) hd.classList.remove('live', 'session');
  chip.classList.remove('timing');

  if (live) {
    if (sessionActive) {
      dot.classList.add('session'); if (hd) hd.classList.add('session');
      lbl.textContent = 'Session'; if (ht) ht.textContent = 'Session recording';
      chip.classList.add('timing');
      _sessionStartTs = _sessionStartTs || Date.now();
      clearInterval(_sessionTimerInterval);
      _sessionTimerInterval = setInterval(() => {
        const e = Math.floor((Date.now() - _sessionStartTs) / 1000);
        document.getElementById('session-elapsed').textContent =
          `${Math.floor(e/60)}:${String(e%60).padStart(2,'0')}`;
      }, 1000);
    } else {
      dot.classList.add('live'); if (hd) hd.classList.add('live');
      lbl.textContent = (backend || 'Live').replace('Recorder','').trim() || 'Live';
      if (ht) ht.textContent = 'Recording';
      clearSessionTimer();
    }
  } else {
    lbl.textContent = 'Idle'; if (ht) ht.textContent = 'Idle';
    clearSessionTimer();
  }
  setText('hero-backend', runtimeBackend || 'auto');
  setText('about-backend', runtimeBackend || 'auto');
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
    setRecStatus(d.recording, d.backend, d.session_active);
    applyHotkeyAvailability(d.hotkeys_available);
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
