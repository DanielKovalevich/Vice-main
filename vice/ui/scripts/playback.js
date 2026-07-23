'use strict';
// playback.js - persisted volume shared by every interactive preview surface

let previewVolumeTimer = null;
let previewVolumeApplying = false;
let previewVolumeSaveError = false;

function normalizePreviewVolume(value) {
  const volume = Number(value);
  return Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
}

function applyPreviewVolume() {
  previewVolumeApplying = true;
  for (const id of ['viewer-video', 'trim-video']) {
    const media = document.getElementById(id);
    if (!media) continue;
    media.muted = false;
    media.volume = previewVolume;
  }
  document.querySelectorAll('[data-preview-volume]').forEach(control => {
    control.value = String(Math.round(previewVolume * 100));
    control.setAttribute('aria-valuetext', `${Math.round(previewVolume * 100)}%`);
  });
  document.querySelectorAll('[data-preview-volume-value]').forEach(label => {
    label.textContent = `${Math.round(previewVolume * 100)}%`;
  });
  previewVolumeApplying = false;
  if (typeof edSetEditorPreviewVolume === 'function') {
    edSetEditorPreviewVolume(previewVolume);
  }
}

async function persistPreviewVolume() {
  try {
    const response = await fetch('/api/app-state', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({preview_volume: previewVolume}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(data.error || 'save failed');
    }
    previewVolumeSaveError = false;
  } catch (_) {
    if (!previewVolumeSaveError) toast('Preview volume could not be saved', 'err');
    previewVolumeSaveError = true;
  }
}

function setPreviewVolume(value, options = {}) {
  previewVolume = normalizePreviewVolume(value);
  applyPreviewVolume();
  if (options.persist === false) return;
  clearTimeout(previewVolumeTimer);
  previewVolumeTimer = setTimeout(persistPreviewVolume, 250);
}

function previewVolumeInput(percent) {
  setPreviewVolume(Number(percent) / 100);
}

function previewMediaVolumeChanged(event) {
  if (previewVolumeApplying) return;
  const media = event.currentTarget;
  const next = media.muted ? 0 : media.volume;
  if (Math.abs(next - previewVolume) < 0.001) return;
  setPreviewVolume(next);
}

function initPlaybackVolume() {
  for (const id of ['viewer-video', 'trim-video']) {
    document.getElementById(id)?.addEventListener('volumechange', previewMediaVolumeChanged);
  }
  applyPreviewVolume();
}

async function fetchAppState() {
  const response = await fetch('/api/app-state');
  if (!response.ok) throw new Error(`app state failed (${response.status})`);
  const state = await response.json();
  setPreviewVolume(state.preview_volume, {persist: false});
  return state;
}
