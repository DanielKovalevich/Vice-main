'use strict';
// init.js — DOMContentLoaded bootstrap + window resize hook

// ═══════════════════════════════════════════════════════════════════
// Bootstrap
// ═══════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  // Theme: load before first paint of swatches/colors stick
  const savedTheme = localStorage.getItem('vice-theme') || 'blue';
  setTheme(savedTheme, /*persist*/false);

  moveNavIndicator();
  populateBufferViz();
  populateHomeFromCfg();
  syncFormFromCfg();
  renderClips();
  renderHomeRecent();
  renderStats();

  if (IS_NATIVE) document.getElementById('quit-row').style.display = 'flex';

  // Trim modal video event hooks
  const tvid = document.getElementById('trim-video');
  tvid.addEventListener('loadedmetadata', onTrimVideoMeta);
  tvid.addEventListener('timeupdate', syncTrimPlayhead);

  // Trim handle dragging (mouse + touch)
  document.getElementById('tl-h-start').addEventListener('mousedown',  e => { dragging = 'start'; e.preventDefault(); });
  document.getElementById('tl-h-end').addEventListener('mousedown',    e => { dragging = 'end';   e.preventDefault(); });
  document.getElementById('tl-h-start').addEventListener('touchstart', e => { dragging = 'start'; e.preventDefault(); }, {passive:false});
  document.getElementById('tl-h-end').addEventListener('touchstart',   e => { dragging = 'end';   e.preventDefault(); }, {passive:false});
  document.addEventListener('mousemove', e => onTrimDragMove(e.clientX));
  document.addEventListener('touchmove', e => { if (e.touches[0]) onTrimDragMove(e.touches[0].clientX); }, {passive:true});
  document.addEventListener('mouseup',  () => { dragging = null; });
  document.addEventListener('touchend', () => { dragging = null; });
  document.getElementById('timeline').addEventListener('click', e => {
    if (dragging || !trimTotal) return;
    const rect = e.currentTarget.getBoundingClientRect();
    document.getElementById('trim-video').currentTime =
      ((e.clientX - rect.left) / rect.width) * trimTotal;
  });

  // Viewer video timeupdate
  const vvid = document.getElementById('viewer-video');
  vvid.addEventListener('timeupdate', () => {
    if (!vvid.duration) return;
    const pct = (vvid.currentTime / vvid.duration) * 100;
    document.getElementById('viewer-playhead').style.left = pct + '%';
    document.getElementById('viewer-progress').style.width = pct + '%';
  });
  vvid.addEventListener('loadedmetadata', () => renderViewerHighlights());

  // Settings rail navigation: scroll target into view
  document.addEventListener('click', e => {
    const rail = e.target.closest('.rail-item');
    if (!rail) return;
    document.querySelectorAll('.rail-item').forEach(r => r.classList.remove('active'));
    rail.classList.add('active');
    const target = document.querySelector(`[data-section="${rail.dataset.rail}"]`);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // Initial backend data — chained because order matters
  fetchConfig().then(() => {
    fetchClips();
    fetchStatus();
  });
  connectWS();

  // First-run tutorial
  if (!localStorage.getItem('vice_tutorial_shown')) {
    document.getElementById('tutorial-modal').classList.remove('hidden');
  }
});
window.addEventListener('resize', moveNavIndicator);
