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
    await refreshAudioSources(cfg.recording?.gsr_audio_source ?? 'default_output');
  } catch (_) {}
}

function pick(id, val) {
  const el = document.getElementById(id);
  if (!el) return;
  for (const o of el.options) { if (o.value === String(val)) { el.value = String(val); return; } }
  el.value = String(val);
}

function syncFormFromCfg() {
  const r = cfg.recording || {}, h = cfg.hotkeys || {}, o = cfg.output || {}, s = cfg.sharing || {}, d = cfg.discord || {};

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
  pick('s-gsr-audio', r.gsr_audio_source ?? 'default_output');
  pick('s-wf-mic', r.wf_microphone_strategy ?? 'prompt');
  document.getElementById('s-gsr-args').value = r.gsr_args ?? '';
  const clipKey = h.clip ?? 'KEY_F9';
  document.getElementById('s-key').value = clipKey;
  document.getElementById('s-key-btn').textContent = clipKey;
  renderClipPresetRows(h.clip_presets || []);
  document.getElementById('s-dir').value  = o.directory  ?? '';
  document.getElementById('s-port').value = s.port       ?? 8765;
  document.getElementById('s-cf').checked = s.cloudflare_tunnel !== false;
  // Discord
  document.getElementById('s-discord-enabled').checked = !!d.enabled;
  document.getElementById('s-discord-client-id').value = d.client_id_override ?? '';
  document.getElementById('s-discord-custom-games').value = (Array.isArray(d.custom_games) ? d.custom_games : [])
    .map(g => `${g.name} | ${(g.matches || []).join(', ')}`)
    .join('\n');
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
  for (const key of ['recording','hotkeys','output','sharing','discord']) {
    if (!patch[key]) continue;
    cfg[key] = { ...(cfg[key] || {}), ...patch[key] };
  }
}

function renderClipPresetRows(presets) {
  const list = document.getElementById('clip-preset-list');
  if (!list) return;
  list.innerHTML = '';
  const rows = Array.isArray(presets) ? presets : [];
  rows.forEach(p => appendClipPresetRow(p.key || '', p.duration || 60));
}

function appendClipPresetRow(key = '', duration = 60) {
  const list = document.getElementById('clip-preset-list');
  if (!list) return;
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const row = document.createElement('div');
  row.className = 'clip-preset-row';
  row.innerHTML = `
    <button id="clip-preset-btn-${id}" class="key-capture-btn mono" type="button"
            onclick="startKeyCapture('clip-preset-btn-${id}', 'clip-preset-key-${id}', false)">${escHtml(key || 'Set key')}</button>
    <input type="hidden" id="clip-preset-key-${id}" class="clip-preset-key" value="${escHtml(key)}">
    <input type="number" class="clip-preset-duration" min="5" max="600" step="5" value="${Number(duration) || 60}">
    <span class="clip-preset-unit mono">s</span>
    <button class="btn-pill btn-ghost-pill btn-sm clip-preset-remove" type="button"
            onclick="this.closest('.clip-preset-row').remove()" title="Remove hotkey" aria-label="Remove hotkey">&times;</button>
  `;
  list.appendChild(row);
}

function addClipPresetRow() {
  appendClipPresetRow('', 60);
}

function collectClipPresetRows() {
  return [...document.querySelectorAll('.clip-preset-row')].map(row => ({
    key: row.querySelector('.clip-preset-key')?.value?.trim() || '',
    duration: Number(row.querySelector('.clip-preset-duration')?.value || 60),
  })).filter(row => row.key || row.duration);
}

// Parse the Discord custom-games textarea. Each non-empty line is
// `Display Name | match1, match2, ...`. Empty `name` or `matches` drops the line.
function parseDiscordCustomGames(text) {
  const out = [];
  for (const raw of (text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const [namePart, matchPart = ''] = line.split('|');
    const name = (namePart || '').trim();
    const matches = matchPart.split(',').map(s => s.trim()).filter(Boolean);
    if (!name || matches.length === 0) continue;
    out.push({ name, matches });
  }
  return out;
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
function defaultDisplayNote() { return 'Choose which display to record (Auto = backend default)'; }
function setDisplayNote(message, warning = false) {
  const el = document.getElementById('s-display-note');
  if (!el) return;
  el.textContent = message || defaultDisplayNote();
  el.style.color = warning ? '#fcd34d' : 'var(--text-dim)';
}
function setAudioSourceNote(message, warning = false) {
  const el = document.getElementById('s-gsr-audio-note');
  if (!el) return;
  el.textContent = message || 'Choose what gpu-screen-recorder captures';
  el.style.color = warning ? '#fcd34d' : 'var(--text-dim)';
}
function renderDisplayOptions(info, selectedDisplay = null) {
  const el = document.getElementById('s-display');
  if (!el) return;
  const raw = Array.isArray(info.displays) ? info.displays : [];
  // Defense-in-depth: drop any entry whose id or label looks like a GSR
  // error/diagnostic string. The backend already filters these, but if a new
  // GSR error format slips through we'd rather show "no displays" than render
  // a broken option that crashes recording.
  const looksLikeError = (s) => {
    const v = String(s || '').toLowerCase();
    return v.startsWith('gsr error')
        || v.startsWith('error:')
        || v.includes('for_each_active_monitor')
        || v.includes('failed to open');
  };
  const displays = raw.filter(d => !(looksLikeError(d.id) || looksLikeError(d.label)));
  const desired = selectedDisplay ?? '';
  el.innerHTML = '';
  el.add(new Option('Auto (backend default)', ''));
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

function renderAudioSources(info, selectedSource = 'default_output') {
  const el = document.getElementById('s-gsr-audio');
  if (!el) return;
  const sources = Array.isArray(info.sources) && info.sources.length
    ? info.sources
    : [{ id: 'default_output', label: 'Default output' }];
  const desired = selectedSource || 'default_output';
  el.innerHTML = '';
  for (const source of sources) el.add(new Option(source.label || source.id, source.id));
  if (sources.some(source => source.id === desired)) {
    el.value = desired;
    setAudioSourceNote('Choose what gpu-screen-recorder captures');
    return;
  }
  el.add(new Option(`${desired} (saved)`, desired));
  el.value = desired;
  setAudioSourceNote(info.warning || 'Saved source was not listed right now, but it will still be passed to gpu-screen-recorder.', true);
}

async function refreshAudioSources(selectedSource = 'default_output') {
  try {
    const resp = await fetch('/api/audio-sources');
    audioSourceInfo = await resp.json();
  } catch (_) {
    audioSourceInfo = { sources: [{ id: 'default_output', label: 'Default output' }], warning: 'Could not load audio sources.' };
  }
  renderAudioSources(audioSourceInfo, selectedSource);
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
  copyToClipboard(tunnelUrl).then(ok => {
    if (ok) toast('Public URL copied!', 'ok');
    else showManualCopyModal(tunnelUrl);
  });
}

async function saveSettings() {
  const clipPresets = collectClipPresetRows();
  const maxClipDuration = Math.max(
    +document.getElementById('s-dur').value,
    ...clipPresets.map(p => Number(p.duration) || 0),
  );
  const bufferDuration = Math.max(+document.getElementById('s-buf').value, maxClipDuration);
  if (+document.getElementById('s-buf').value !== bufferDuration) {
    document.getElementById('s-buf').value = bufferDuration;
    setText('s-buf-v', fmtSec(bufferDuration));
  }
  const body = {
    recording: {
      buffer_duration: bufferDuration,
      clip_duration:   +document.getElementById('s-dur').value,
      fps:             +document.getElementById('s-fps').value,
      display:         document.getElementById('s-display').value || null,
      resolution:      document.getElementById('s-res').value || null,
      encoder:         document.getElementById('s-enc').value,
      backend:         document.getElementById('s-backend').value,
      capture_audio:   document.getElementById('s-audio').checked,
      capture_microphone: document.getElementById('clips-mic-toggle').checked,
      wf_microphone_strategy: document.getElementById('s-wf-mic').value,
      gsr_audio_source: document.getElementById('s-gsr-audio').value || 'default_output',
      gsr_args:        document.getElementById('s-gsr-args').value.trim(),
    },
    hotkeys: {
      clip: document.getElementById('s-key').value,
      clip_presets: clipPresets,
    },
    output:  { directory: document.getElementById('s-dir').value },
    sharing: {
      port:              +document.getElementById('s-port').value,
      cloudflare_tunnel: document.getElementById('s-cf').checked,
    },
    discord: {
      enabled: document.getElementById('s-discord-enabled').checked,
      client_id_override: document.getElementById('s-discord-client-id').value.trim() || null,
      custom_games: parseDiscordCustomGames(document.getElementById('s-discord-custom-games').value),
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
  } catch (err) { toast(err?.message || 'Failed to save settings', 'err'); }
}
