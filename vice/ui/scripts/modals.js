'use strict';
// modals.js — tutorial / restart / wf-mic modal open/close

// ═══════════════════════════════════════════════════════════════════
// Tutorial / restart / wf-mic modals
// ═══════════════════════════════════════════════════════════════════
function showTutorial() {
  syncDynamicCopy();
  document.getElementById('tutorial-modal').classList.remove('hidden');
}
function closeTutorial() {
  localStorage.setItem('vice_tutorial_shown', '1');
  document.getElementById('tutorial-modal').classList.add('hidden');
}
function showManualCopyModal(text) {
  const input = document.getElementById('manual-copy-text');
  input.value = text;
  document.getElementById('manual-copy-modal').classList.remove('hidden');
  input.focus();
  input.select();
}
function closeManualCopyModal() {
  document.getElementById('manual-copy-modal').classList.add('hidden');
}
function showRestartModal() {
  document.getElementById('restart-modal').classList.remove('hidden');
}
function closeRestartModal() {
  document.getElementById('restart-modal').classList.add('hidden');
}
function openWfMicModal() {
  document.getElementById('wf-mic-modal').classList.remove('hidden');
}
function closeWfMicModal() {
  pendingMicToggle = null;
  document.getElementById('wf-mic-modal').classList.add('hidden');
  syncMicToggles();
}
async function chooseWfMicStrategy(strategy) {
  if (pendingMicToggle !== true) { closeWfMicModal(); return; }
  document.getElementById('wf-mic-modal').classList.add('hidden');
  pendingMicToggle = null;
  await saveClipMicToggle(true, strategy);
}
