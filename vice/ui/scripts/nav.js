'use strict';
// nav.js — top-bar pill nav + sliding indicator

// ═══════════════════════════════════════════════════════════════════
// Navigation
// ═══════════════════════════════════════════════════════════════════
function nav(name) {
  currentView = name;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
  document.querySelectorAll('.nav-pill').forEach(p => p.classList.toggle('active', p.dataset.view === name));
  moveNavIndicator();
  // Stop any clip-card hover preview when switching pages
  stopActivePreview(true);
}

function moveNavIndicator() {
  const active = document.querySelector('.nav-pill.active');
  const ind = document.getElementById('nav-indicator');
  if (!active || !ind) return;
  const parent = active.parentElement;
  const pRect = parent.getBoundingClientRect();
  const aRect = active.getBoundingClientRect();
  ind.style.left = (aRect.left - pRect.left) + 'px';
  ind.style.width = aRect.width + 'px';
}
