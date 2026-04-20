'use strict';
// settings.js — settings form, persistence, mic/audio/tunnel toggles

// ═══════════════════════════════════════════════════════════════════
// Settings — fetch + save against /api/config
// ═══════════════════════════════════════════════════════════════════
async function fetchConfig() {
  try {
    const r = await fetch('/api/config');
    cfg = await r.json();
    syncFormFromCfg();
    populateHomeFromCfg();
    await refreshDisplayOptions(cfg.recording?.backend ?? 'auto', cfg.recording?.display ?? null);
  } catch (_) {}
}

function pick(id, val) {
  const el = document.getElementById(id);
  if (!el) return;
  for (const o of el.options) { if (o.value === String(val)) { el.value = String(val); return; } }
  el.value = String(val);
}

function syncFormFromCfg() {
  const r = cfg.recording || {}, h = cfg.hotkeys || {}, o = cfg.output || {}, s = cfg.sharing || {};

  const buf = r.buffer_duration ?? 120;
  document.getElementById('s-buf').value = buf;
  setText('s-buf-v', fmtSec(buf));
  const dur = r.clip_duration ?? 15;
  document.getElementById('s-dur').value = dur;
  setText('s-dur-v', fmtSec(dur));

  pick('s-fps', String(r.fps ?? 60));
  pick('s-res', r.resolution ?? '');
  pick('s-enc', r.encoder ?? 'auto');
  pick('s-backend', r.backend ?? 'auto');
  document.getElementById('s-audio').checked = r.capture_audio !== false;
  pick('s-wf-mic', r.wf_microphone_strategy ?? 'prompt');
  document.getElementById('s-gsr-args').value = r.gsr_args ?? '';
  const clipKey = h.clip ?? 'KEY_F9';
  document.getElementById('s-key').value = clipKey;
  document.getElementById('s-key-btn').textContent = clipKey;
  document.getElementById('s-dir').value  = o.directory  ?? '';
  document.getElementById('s-port').value = s.port       ?? 8765;
  document.getElementById('s-cf').checked = s.cloudflare_tunnel !== false;
  syncMicToggles();
}

function syncMicToggles() {
  const mic = !!cfg.recording?.capture_microphone;
  const audio = cfg.recording?.capture_audio !== false;
  const cf = cfg.sharing?.cloudflare_tunnel !== false;
  const cm = document.getElementById('clips-mic-toggle'); if (cm) cm.checked = mic;
  const hm = document.getElementById('home-mic-toggle');  if (hm) hm.checked = mic;
  const ha = document.getElementById('home-audio-toggle'); if (ha) ha.checked = audio;
  const hc = document.getElementById('home-cf-toggle');    if (hc) hc.checked = cf;
}

function mergeConfigState(patch) {
  cfg = cfg || {};
  for (const key of ['recording','hotkeys','output','sharing']) {
    if (!patch[key]) continue;
    cfg[key] = { ...(cfg[key] || {}), ...patch[key] };
  }
}

async function persistConfig(body) {
  const resp = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.ok === false) throw new Error(data.error || 'save failed');
  mergeConfigState(body);
  return data;
}

function selectedBackend() { return document.getElementById('s-backend')?.value || 'auto'; }
function defaultDisplayNote() { return 'Choose which display to record (Auto = current display)'; }
function setDisplayNote(message, warning = false) {
  const el = document.getElementById('s-display-note');
  if (!el) return;
  el.textContent = message || defaultDisplayNote();
  el.style.color = warning ? '#fcd34d' : 'var(--text-dim)';
}
function renderDisplayOptions(info, selectedDisplay = null) {
  const el = document.getElementById('s-display');
  if (!el) return;
  const displays = Array.isArray(info.displays) ? info.displays : [];
  const desired = selectedDisplay ?? '';
  el.innerHTML = '';
  el.add(new Option('Auto (current display)', ''));
  for (const item of displays) el.add(new Option(item.label || item.id, item.id));
  if (desired && displays.some(item => item.id === desired)) {
    el.value = desired; setDisplayNote(defaultDisplayNote()); return;
  }
  el.value = '';
  if (desired) { setDisplayNote(`Saved display "${desired}" is unavailable right now. Auto will be used.`, true); return; }
  if (info.warning) { setDisplayNote(`${info.warning} Auto will still work.`, true); return; }
  if (!displays.length) { setDisplayNote('No individual displays were detected. Auto will still work.', true); return; }
  setDisplayNote(defaultDisplayNote());
}
async function refreshDisplayOptions(backend = selectedBackend(), selectedDisplay = null) {
  try {
    const resp = await fetch(`/api/displays?backend=${encodeURIComponent(backend || 'auto')}`);
    displayInfo = await resp.json();
  } catch (_) {
    displayInfo = { backend: backend || 'auto', displays: [], warning: 'Could not load display options.' };
  }
  renderDisplayOptions(displayInfo, selectedDisplay);
}
async function onBackendChange() {
  const preferred = document.getElementById('s-display')?.value || cfg.recording?.display || null;
  await refreshDisplayOptions(selectedBackend(), preferred);
}

function selectedWfMicStrategy() { return cfg.recording?.wf_microphone_strategy || 'prompt'; }
function micToggleNeedsWfChoice(targetChecked) {
  if (!targetChecked) return false;
  if (cfg.recording?.capture_audio === false) return false;
  if (selectedWfMicStrategy() !== 'prompt') return false;
  const configuredBackend = cfg.recording?.backend || 'auto';
  return configuredBackend === 'wf-recorder' || runtimeBackend === 'wf-recorder';
}
async function onClipMicToggleChange(el) {
  const targetChecked = !!el.checked;
  if (micToggleNeedsWfChoice(targetChecked)) {
    pendingMicToggle = true;
    el.checked = false;
    syncMicToggles();
    openWfMicModal();
    return;
  }
  await saveClipMicToggle(targetChecked);
}
async function saveClipMicToggle(enabled, strategyOverride = null) {
  const prev = !!cfg.recording?.capture_microphone;
  const body = { recording: { capture_microphone: enabled } };
  if (strategyOverride !== null) body.recording.wf_microphone_strategy = strategyOverride;
  try {
    const data = await persistConfig(body);
    if (data.applied === false && data.warning) toast(data.warning, 'err');
    else toast(enabled ? 'Microphone audio enabled for new clips' : 'Microphone audio removed from new clips', 'ok');
    document.getElementById('s-wf-mic').value = selectedWfMicStrategy();
    syncMicToggles();
  } catch (_) {
    cfg.recording = cfg.recording || {};
    cfg.recording.capture_microphone = prev;
    syncMicToggles();
    toast('Failed to update microphone setting', 'err');
  }
}

async function onHomeAudioToggle(el) {
  const target = !!el.checked;
  try {
    await persistConfig({ recording: { capture_audio: target } });
    document.getElementById('s-audio').checked = target;
    toast(target ? 'Desktop audio on' : 'Desktop audio off', 'ok');
  } catch (_) { el.checked = !target; toast('Failed to update audio', 'err'); }
}

async function onHomeTunnelToggle(el) {
  const target = !!el.checked;
  const ro = document.getElementById('tunnel-readout');
  const rt = document.getElementById('tunnel-readout-text');
  try {
    const data = await persistConfig({ sharing: { cloudflare_tunnel: target } });
    document.getElementById('s-cf').checked = target;
    if (target) {
      ro.classList.add('active');
      rt.textContent = tunnelUrl || 'Tunnel starting…';
      toast('Public tunnel starting…', 'ok');
    } else {
      ro.classList.remove('active');
      rt.textContent = 'Tunnel inactive';
      tunnelUrl = null;
      toast('Tunnel stopped', 'ok');
    }
    if (data.restart_required) showRestartModal();
  } catch (_) { el.checked = !target; toast('Failed to toggle tunnel', 'err'); }
}

function copyTunnelUrl() {
  if (!tunnelUrl) { toast('Enable the tunnel first', 'err'); return; }
  navigator.clipboard.writeText(tunnelUrl)
    .then(() => toast('Public URL copied!', 'ok'))
    .catch(() => toast('Could not copy', 'err'));
}

async function saveSettings() {
  const body = {
    recording: {
      buffer_duration: +document.getElementById('s-buf').value,
      clip_duration:   +document.getElementById('s-dur').value,
      fps:             +document.getElementById('s-fps').value,
      display:         document.getElementById('s-display').value || null,
      resolution:      document.getElementById('s-res').value || null,
      encoder:         document.getElementById('s-enc').value,
      backend:         document.getElementById('s-backend').value,
      capture_audio:   document.getElementById('s-audio').checked,
      capture_microphone: document.getElementById('clips-mic-toggle').checked,
      wf_microphone_strategy: document.getElementById('s-wf-mic').value,
      gsr_args:        document.getElementById('s-gsr-args').value.trim(),
    },
    hotkeys: { clip: document.getElementById('s-key').value },
    output:  { directory: document.getElementById('s-dir').value },
    sharing: {
      port:              +document.getElementById('s-port').value,
      cloudflare_tunnel: document.getElementById('s-cf').checked,
    },
  };
  try {
    const currentSharing = cfg.sharing || {};
    const sharingChanged =
      Number(body.sharing.port) !== Number(currentSharing.port ?? 8765)
      || Boolean(body.sharing.cloudflare_tunnel) !== Boolean(currentSharing.cloudflare_tunnel !== false);

    const data = await persistConfig(body);
    if (data.applied === false && data.warning) toast(data.warning, 'err');
    if (data.restart_required && sharingChanged) showRestartModal();

    populateHomeFromCfg();
    renderStats();
    renderClips();
    renderHomeRecent();
    const m = document.getElementById('saved-msg');
    m.classList.add('show'); setTimeout(() => m.classList.remove('show'), 2400);
  } catch (_) { toast('Failed to save settings', 'err'); }
}
