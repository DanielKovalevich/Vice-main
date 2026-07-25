'use strict';
// nav.js — sidebar navigation + search + back/forward history

// ═══════════════════════════════════════════════════════════════════
// Navigation
// ═══════════════════════════════════════════════════════════════════
// Internal view-history stack. We drive back/forward ourselves rather than
// leaning on the History API so it behaves identically in the QtWebEngine
// native window and in a browser tab, and so mouse buttons 3/4 map cleanly.
let navHistory = [];
let navPos = -1;

function nav(name, playlistId = null, opts = {}) {
  const wasEditor = currentView === 'editor';
  currentView = name;
  currentPlaylistId = name === 'clips' ? playlistId : null;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
  updateSidebarActive();
  // Stop any clip-card hover preview when switching pages
  stopActivePreview(true);
  if (wasEditor && name !== 'editor') editorLeave();
  if (name === 'editor') editorEnter();
  if (name === 'clips') renderClips();
  // The home rows size themselves to the row width, which is only
  // measurable while the view is visible.
  if (name === 'home') { renderHomeRecent(); renderMostViewed(); }
  // Audio sources change as apps start and stop playing sound, so the
  // pickers re-fetch every time settings opens (issue #98).
  if (name === 'settings') {
    refreshAudioSources();
    refreshYouTubeStatus();
  }
  if (!opts.fromHistory) pushNavHistory(name, currentPlaylistId);
  updateNavButtons();
}

function pushNavHistory(view, playlistId) {
  const pid = playlistId ?? null;
  const top = navHistory[navPos];
  // Collapse repeated navigations to the same place (e.g. re-clicking a tab).
  if (top && top.view === view && top.playlistId === pid) return;
  navHistory = navHistory.slice(0, navPos + 1);
  navHistory.push({ view, playlistId: pid });
  navPos = navHistory.length - 1;
}

function navBack() {
  if (navPos <= 0) return;
  navPos--;
  const e = navHistory[navPos];
  nav(e.view, e.playlistId, { fromHistory: true });
}

function navForward() {
  if (navPos >= navHistory.length - 1) return;
  navPos++;
  const e = navHistory[navPos];
  nav(e.view, e.playlistId, { fromHistory: true });
}

function updateNavButtons() {
  const back = document.getElementById('nav-back');
  const fwd = document.getElementById('nav-fwd');
  if (back) {
    const can = navPos > 0;
    back.classList.toggle('dim', !can);
    back.disabled = !can;
  }
  if (fwd) {
    const can = navPos >= 0 && navPos < navHistory.length - 1;
    fwd.classList.toggle('dim', !can);
    fwd.disabled = !can;
  }
}

// Seed the stack with the initial view and wire mouse back/forward buttons.
function initNavHistory() {
  pushNavHistory(currentView || 'home', currentPlaylistId);
  updateNavButtons();
  // Buttons 3 (back) and 4 (forward) also drive the browser's own history in
  // some engines; suppress that on press so we navigate exactly once.
  document.addEventListener('mousedown', e => {
    if (e.button === 3 || e.button === 4) e.preventDefault();
  });
  document.addEventListener('mouseup', e => {
    if (e.button === 3) { e.preventDefault(); navBack(); }
    else if (e.button === 4) { e.preventDefault(); navForward(); }
  });
}

function openPlaylist(id) {
  nav('clips', id);
}

function updateSidebarActive() {
  document.querySelectorAll('.side-item').forEach(el =>
    el.classList.toggle('active', el.dataset.view === currentView && !currentPlaylistId));
  document.querySelectorAll('.side-pl-row').forEach(el =>
    el.classList.toggle('active', el.dataset.playlist === currentPlaylistId));
}

// Search filters name + game and jumps to the clips view while non-empty.
function onSearch(value) {
  searchQuery = value || '';
  if (searchQuery.trim() && currentView !== 'clips') {
    nav('clips');
  } else if (currentView === 'clips') {
    renderClips();
  }
}
