'use strict';
// theme.js — accent-color swatches with localStorage persistence

// ═══════════════════════════════════════════════════════════════════
// Theme (5 swatches; persists in localStorage)
// ═══════════════════════════════════════════════════════════════════
const THEMES = {
  blue:   { hex: '#0099ff', rgb: '0,153,255' },
  purple: { hex: '#8b5cf6', rgb: '139,92,246' },
  green:  { hex: '#10b981', rgb: '16,185,129' },
  red:    { hex: '#ef4444', rgb: '239,68,68' },
  orange: { hex: '#f97316', rgb: '249,115,22' },
};
function setTheme(name, persist = true) {
  const t = THEMES[name]; if (!t) return;
  document.documentElement.style.setProperty('--accent', t.hex);
  document.documentElement.style.setProperty('--accent-rgb', t.rgb);
  document.querySelectorAll('.swatch').forEach(s => s.classList.toggle('active', s.dataset.theme === name));
  if (persist) {
    localStorage.setItem('vice-theme', name);
    // Keep share-page embeds (Discord sidebar strip) on the same accent.
    fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sharing: { embed_color: t.hex } }),
    }).catch(() => {});
  }
}
