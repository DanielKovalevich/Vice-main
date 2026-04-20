'use strict';
// trim.js — trim modal: video + draggable timeline handles

// ═══════════════════════════════════════════════════════════════════
// Trim modal
// ═══════════════════════════════════════════════════════════════════
function openTrim(slug, videoUrl) {
  trimSlug = slug;
  document.getElementById('trim-title').textContent = `Trim — ${slug}`;
  document.getElementById('trim-status').textContent = '';
  const btn = document.getElementById('trim-save-btn');
  btn.disabled = false;
  btn.innerHTML = `${svgEl('scissors')} Save trim`;
  const vid = document.getElementById('trim-video');
  vid.src = videoUrl;
  document.getElementById('trim-modal').classList.add('open');
}
function onTrimVideoMeta() {
  const v = document.getElementById('trim-video');
  trimTotal = v.duration || 0;
  trimS = 0; trimE = trimTotal;
  renderTrimHandles(); refreshTrimUI();
}
function closeTrim() {
  document.getElementById('trim-modal').classList.remove('open');
  const v = document.getElementById('trim-video');
  v.pause(); v.src = '';
  trimSlug = null;
}
function onBackdropClick(e) {
  if (e.target.id === 'trim-modal') closeTrim();
}
function renderTrimHandles() {
  if (!trimTotal) return;
  const sp = (trimS/trimTotal)*100, ep = (trimE/trimTotal)*100;
  document.getElementById('tl-h-start').style.left = sp + '%';
  document.getElementById('tl-h-end').style.left   = ep + '%';
  document.getElementById('tl-sel').style.left  = sp + '%';
  document.getElementById('tl-sel').style.width = (ep - sp) + '%';
}
function refreshTrimUI() {
  setText('t-in',  fmtSec(trimS, true));
  setText('t-out', fmtSec(trimE, true));
  setText('t-dur', fmtSec(Math.max(0, trimE - trimS), true));
  setText('tc-start', toTC(trimS));
  setText('tc-end',   toTC(trimE));
}
function syncTrimPlayhead() {
  if (!trimTotal) return;
  const p = (document.getElementById('trim-video').currentTime / trimTotal) * 100;
  document.getElementById('tl-playhead').style.left = p + '%';
}
function onTrimDragMove(cx) {
  if (!dragging || !trimTotal) return;
  const tl = document.getElementById('timeline');
  const rect = tl.getBoundingClientRect();
  const x = Math.max(0, Math.min(rect.width, cx - rect.left));
  const t = (x / rect.width) * trimTotal;
  const MIN = 0.5;
  const vid = document.getElementById('trim-video');
  if (dragging === 'start') { trimS = Math.max(0, Math.min(t, trimE - MIN)); vid.currentTime = trimS; }
  else                       { trimE = Math.min(trimTotal, Math.max(t, trimS + MIN)); vid.currentTime = trimE; }
  renderTrimHandles(); refreshTrimUI();
}
async function saveTrim() {
  if (!trimSlug) return;
  const btn = document.getElementById('trim-save-btn');
  const sta = document.getElementById('trim-status');
  btn.disabled = true; btn.textContent = 'Saving…'; sta.textContent = '';
  try {
    const r = await fetch(`/api/clips/${encodeURIComponent(trimSlug)}/trim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start: trimS, end: trimE }),
    });
    const data = await r.json();
    if (data.ok) {
      toast('Clip trimmed and saved!', 'ok');
      closeTrim();
      await fetchClips();
    } else {
      sta.textContent = data.error || 'Trim failed';
      toast(data.error || 'Trim failed', 'err');
      btn.disabled = false;
      btn.innerHTML = `${svgEl('scissors')} Save trim`;
    }
  } catch (_) {
    toast('Failed to save trim', 'err');
    btn.disabled = false;
    btn.innerHTML = `${svgEl('scissors')} Save trim`;
  }
}
