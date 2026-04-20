'use strict';
// state.js — shared mutable state + IS_NATIVE detection

// ───── State (defaults; overwritten by /api/config on init)
let cfg = {
  recording: { buffer_duration: 120, clip_duration: 15, fps: 60, encoder: 'auto',
               backend: 'auto', display: null, resolution: null, capture_audio: true,
               capture_microphone: false, wf_microphone_strategy: 'prompt', gsr_args: '' },
  hotkeys:  { clip: 'KEY_F9' },
  output:   { directory: '~/Videos/Vice' },
  sharing:  { port: 8765, cloudflare_tunnel: true },
};
let clips     = [];
let ws        = null;
let recentNew = new Set();
let tunnelUrl = null;
let hotkeysAvailable = true;
let runtimeBackend = 'auto';
let pendingMicToggle = null;
let displayInfo = { backend: 'auto', displays: [], warning: null };
let currentView = 'home';

// Trim state
let trimSlug  = null;
let trimS     = 0;
let trimE     = 0;
let trimTotal = 0;
let dragging  = null;

// pywebview detection
const IS_NATIVE = typeof window.pywebview !== 'undefined';
