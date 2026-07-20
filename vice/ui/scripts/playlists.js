'use strict';
// playlists.js — sidebar rows, home tiles, detail header, modal, add menu

// Same 8 gradient pairs as the backend's auto-playlist palette.
const PL_COLORS = [
  ['#ff7a45','#9a3412'], ['#f0b429','#7c4a03'], ['#34d399','#064e3b'], ['#38bdf8','#075985'],
  ['#8b5cf6','#3b0a74'], ['#f472b6','#831843'], ['#ef4444','#7f1d1d'], ['#a3e635','#3f6212'],
];
let nplColorIdx = 4;

async function fetchPlaylists() {
  try {
    const r = await fetch('/api/playlists');
    playlists = (await r.json()).playlists || [];
  } catch (_) { playlists = []; }
  renderPlaylists();
}

// Count only clips the UI actually has, so stale membership never inflates
// the numbers between a delete and the next playlists_changed broadcast.
function playlistCount(pl) {
  return pl.clip_slugs.filter(s => clips.some(c => c.slug === s)).length;
}

function playlistGradient(pl) {
  return `linear-gradient(150deg, ${pl.color1}, ${pl.color2})`;
}

function renderPlaylists() {
  renderSidebarPlaylists();
  renderHomePlaylists();
  if (currentView === 'clips' && currentPlaylistId) renderClips();
}

function renderSidebarPlaylists() {
  const box = document.getElementById('sidebar-playlists');
  box.innerHTML = playlists.map(pl => `
    <button class="side-pl-row${pl.id === currentPlaylistId ? ' active' : ''}" data-playlist="${escAttr(pl.id)}"
            onclick="openPlaylist('${escAttr(pl.id)}')">
      <span class="side-pl-tile" style="background:${playlistGradient(pl)}">${escHtml(pl.emoji || '')}</span>
      <span class="side-pl-name">${escHtml(pl.name)}</span>
      <span class="side-pl-count">${playlistCount(pl)}</span>
    </button>`).join('');
}

function renderHomePlaylists() {
  const row = document.getElementById('home-playlists');
  const tiles = playlists.map(pl => `
    <div class="home-pl-tile" onclick="openPlaylist('${escAttr(pl.id)}')">
      <div class="home-pl-art" style="background:${playlistGradient(pl)}">
        <span class="home-pl-emoji">${escHtml(pl.emoji || '')}</span>
        <span class="home-pl-name">${escHtml(pl.name)}</span>
      </div>
      <div class="home-pl-meta mono">${playlistCount(pl)} clips · ${pl.kind}</div>
    </div>`).join('');
  row.innerHTML = tiles + `
    <div class="home-pl-tile" onclick="openNewPlaylistModal()">
      <div class="home-pl-tile-new">
        ${svgEl('plus', 20)}
        <span>New playlist</span>
      </div>
    </div>`;
}

function renderPlaylistHeader(pl) {
  const tile = document.getElementById('playlist-header-tile');
  const delBtn = document.getElementById('playlist-delete-btn');
  if (!pl) {
    tile.style.display = 'none';
    delBtn.style.display = 'none';
    return;
  }
  tile.style.display = 'flex';
  tile.style.background = playlistGradient(pl);
  tile.textContent = pl.emoji || '';
  delBtn.style.display = pl.kind === 'custom' ? '' : 'none';
}

async function deleteCurrentPlaylist() {
  const pl = currentPlaylist();
  if (!pl || pl.kind !== 'custom') return;
  if (!confirm(`Delete the playlist "${pl.name}"? The clips themselves stay put.`)) return;
  try {
    await fetch(`/api/playlists/${encodeURIComponent(pl.id)}`, { method: 'DELETE' });
    nav('clips');
    toast('Playlist deleted', 'ok');
  } catch (_) { toast('Failed to delete playlist', 'err'); }
}

// ── New playlist modal ──────────────────────────────────────────────
function openNewPlaylistModal() {
  nplColorIdx = 4;
  document.getElementById('npl-name').value = '';
  document.getElementById('npl-emoji').value = '';
  renderNplPicker();
  document.getElementById('new-playlist-modal').classList.remove('hidden');
  document.getElementById('npl-name').focus();
}

function closeNewPlaylistModal() {
  document.getElementById('new-playlist-modal').classList.add('hidden');
}

function renderNplPicker() {
  const [c1, c2] = PL_COLORS[nplColorIdx];
  const preview = document.getElementById('npl-preview');
  preview.style.background = `linear-gradient(150deg, ${c1}, ${c2})`;
  preview.textContent = document.getElementById('npl-emoji').value.trim();
  document.getElementById('npl-colors').innerHTML = PL_COLORS.map(([a, b], i) => `
    <button class="npl-color${i === nplColorIdx ? ' active' : ''}" style="background:linear-gradient(150deg, ${a}, ${b})"
            onclick="pickNplColor(${i})" aria-label="Colour ${i + 1}"></button>`).join('');
}

function pickNplColor(i) {
  nplColorIdx = i;
  renderNplPicker();
}

async function createPlaylist() {
  const name = document.getElementById('npl-name').value.trim();
  if (!name) { toast('Give the playlist a name', 'err'); return; }
  const [color1, color2] = PL_COLORS[nplColorIdx];
  const emoji = document.getElementById('npl-emoji').value.trim();
  try {
    const r = await fetch('/api/playlists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, emoji, color1, color2 }),
    });
    const data = await r.json();
    if (!data.ok) { toast(data.error || 'Failed to create playlist', 'err'); return; }
    closeNewPlaylistModal();
    if (!playlists.some(p => p.id === data.playlist.id)) playlists.push(data.playlist);
    renderPlaylists();
    openPlaylist(data.playlist.id);
    toast(`Playlist "${name}" created`, 'ok');
  } catch (_) { toast('Failed to create playlist', 'err'); }
}

// ── Add-to-playlist menu (glass popover anchored to the ＋ button) ──
function openPlaylistMenu(ev, slug) {
  ev.preventDefault();
  ev.stopPropagation();
  document.getElementById('pl-menu')?.remove();
  const menu = document.createElement('div');
  menu.id = 'pl-menu';
  menu.className = 'pl-menu';
  const custom = playlists.filter(p => p.kind === 'custom');
  const rows = custom.map(pl => `
    <button class="pl-menu-item" data-playlist="${escAttr(pl.id)}">
      <span class="pl-menu-emoji">${escHtml(pl.emoji || '')}</span>${escHtml(pl.name)}
    </button>`).join('');
  menu.innerHTML = `
    <div class="pl-menu-hd eyebrow-label">ADD TO PLAYLIST</div>
    ${rows || '<div class="pl-menu-empty">No custom playlists yet</div>'}`;
  document.body.appendChild(menu);

  menu.querySelectorAll('.pl-menu-item').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      menu.remove();
      addClipToPlaylist(slug, btn.dataset.playlist);
    };
  });

  const rect = ev.currentTarget.getBoundingClientRect();
  const mw = 200;
  menu.style.left = Math.max(8, Math.min(rect.right - mw, window.innerWidth - mw - 8)) + 'px';
  menu.style.top = Math.min(rect.bottom + 6, window.innerHeight - menu.offsetHeight - 8) + 'px';

  const dismiss = e => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener('click', dismiss, true);
    }
  };
  setTimeout(() => document.addEventListener('click', dismiss, true), 0);
}

async function addClipToPlaylist(slug, playlistId) {
  const pl = playlists.find(p => p.id === playlistId);
  try {
    const r = await fetch(`/api/playlists/${encodeURIComponent(playlistId)}/clips`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug }),
    });
    const data = await r.json();
    if (!data.ok) { toast(data.error || 'Failed to add clip', 'err'); return; }
    toast(`Added to ${pl ? pl.name : 'playlist'}`, 'ok');
  } catch (_) { toast('Failed to add clip', 'err'); }
}
