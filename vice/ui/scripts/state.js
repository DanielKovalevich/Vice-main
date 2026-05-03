'use strict';
// state.js — shared mutable state + IS_NATIVE detection

// ───── State (defaults; overwritten by /api/config on init)
let cfg = {
  recording: { buffer_duration: 120, clip_duration: 15, fps: 60, encoder: 'auto',
               backend: 'auto', display: null, resolution: null, capture_audio: true,
               capture_microphone: false, wf_microphone_strategy: 'prompt',
               gsr_args: '', gsr_audio_source: 'default_output' },
  hotkeys:  { clip: 'KEY_F9', clip_presets: [] },
  output:   { directory: '~/Videos/Vice' },
  sharing:  { port: 8765, cloudflare_tunnel: true },
  discord:  { enabled: true, client_id_override: null, custom_games: [] },
};
let clips     = [];
let ws        = null;
let recentNew = new Set();
let tunnelUrl = null;
let hotkeysAvailable = true;
let runtimeBackend = 'auto';
let pendingMicToggle = null;
let displayInfo = { backend: 'auto', displays: [], warning: null };
let audioSourceInfo = { sources: [], warning: null };
let currentView = 'home';

// Trim state
let trimSlug  = null;
let trimS     = 0;
let trimE     = 0;
let trimTotal = 0;
let dragging  = null;

// Detect the pywebview native window. vice-app passes ?native=1 in the URL
// so we know this at module-load time — pywebview's own window.pywebview is
// only injected after DOMContentLoaded, too late to show the Quit pill on
// the first paint.
const IS_NATIVE = (() => {
  try {
    if (new URLSearchParams(location.search).get('native') === '1') return true;
  } catch (_) {}
  return typeof window.pywebview !== 'undefined';
})();
