'use strict';
// helpers.js — toast, fmt helpers, escape, copy uninstall cmd

// ═══════════════════════════════════════════════════════════════════
// Toasts / helpers
// ═══════════════════════════════════════════════════════════════════
function toast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${svgEl(type === 'ok' ? 'checkCircle2' : 'alertCircle', 14)} ${escHtml(msg)}`;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}
function fmtSec(s, short = false) {
  if (s < 60) return short ? `${s.toFixed(s % 1 ? 1 : 0)}s` : `${s} s`;
  const m = Math.floor(s/60), r = s % 60;
  if (short) return `${m}:${String(Math.floor(r)).padStart(2,'0')}`;
  return r === 0 ? `${m} min` : `${m}:${String(r).padStart(2,'0')} min`;
}
function toTC(s) {
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), se = s%60;
  const ms = String(Math.round((se%1)*1000)).padStart(3,'0');
  return `${pad(h)}:${pad(m)}:${pad(Math.floor(se))}.${ms}`;
}
function pad(n) { return String(n).padStart(2,'0'); }
function escAttr(s) { return String(s).replace(/&/g,'&amp;').replace(/'/g,'&#39;').replace(/"/g,'&quot;'); }
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }

function copyUninstallCmd() {
  navigator.clipboard.writeText('vice uninstall')
    .then(() => toast('Command copied — paste it into a terminal', 'ok'))
    .catch(() => toast('Could not copy', 'err'));
}
