'use strict';
// clip-metadata.js — clip overflow (kebab) menu + Configure-metadata modal.
//
// Replaces the row of per-card action buttons with one accessible overflow
// menu, and adds a modal (opened from that menu or by right-clicking a card)
// for editing a clip's Raw/Edited type, canonical game, and custom playlist
// memberships. Saves go through the transactional /metadata endpoint and are
// applied locally immediately so counts and grouped/active views refresh
// without waiting on the WebSocket echo (finalized items 7–9).

// ── local apply helpers (shared with the add-to-playlist bug fix) ──────────
function applyClipLocal(clip) {
  if (!clip || !clip.slug) return;
  const i = clips.findIndex(c => c.slug === clip.slug);
  if (i >= 0) clips[i] = Object.assign({}, clips[i], clip);
  else clips.unshift(clip);
}
function applyPlaylistsLocal(pls) {
  if (Array.isArray(pls)) playlists = pls;
}
function rerenderAfterMetadata() {
  renderClips();
  renderHomeRecent();
  renderMostViewed();
  renderStats();
  renderPlaylists();
  if (typeof edOnClipsRefreshed === 'function') edOnClipsRefreshed();
}

// ── overflow (kebab) menu ──────────────────────────────────────────────────
let clipMenuEl = null;
let clipMenuBtn = null;

function clipMenuItems(clip) {
  const slug = clip.slug;
  const items = [
    { label: 'Trim',              icon: 'scissors',   run: () => openTrim(slug, clip.video_url || '') },
    { label: 'Upload to YouTube', icon: 'youtube',    run: () => openYouTubeUpload(slug) },
    { label: 'Copy video',        icon: 'clipboard',  run: () => copyClipFile(null, slug) },
  ];
  if (clip.share_url) {
    items.push({ label: 'Copy share link', icon: 'link2',
                 run: () => copyLink(null, clip.share_url, clip.share_is_public !== false) });
  }
  items.push({ label: 'Reveal in files',     icon: 'folderOpen', run: () => revealClip(slug) });
  items.push({ label: 'Configure metadata',  icon: 'sliders',    run: () => openClipMetadata(null, slug) });
  items.push({ label: 'Delete',              icon: 'trash2', danger: true, divider: true,
               run: () => delClip(slug) });
  return items;
}

function closeClipMenu() {
  if (!clipMenuEl) return;
  clipMenuEl.remove();
  clipMenuEl = null;
  document.removeEventListener('keydown', onClipMenuKey, true);
  document.removeEventListener('pointerdown', onClipMenuOutside, true);
  const btn = clipMenuBtn;
  clipMenuBtn = null;
  if (btn && document.contains(btn)) {
    btn.setAttribute('aria-expanded', 'false');
    try { btn.focus(); } catch (_) {}
  }
}

function clipMenuButtons() {
  return clipMenuEl ? [...clipMenuEl.querySelectorAll('.clip-menu-item')] : [];
}

function focusClipMenuItem(idx) {
  const btns = clipMenuButtons();
  if (!btns.length) return;
  const i = (idx + btns.length) % btns.length;
  btns[i].focus();
}

function onClipMenuKey(e) {
  if (!clipMenuEl) return;
  const btns = clipMenuButtons();
  const cur = btns.indexOf(document.activeElement);
  if (e.key === 'Escape') { e.preventDefault(); closeClipMenu(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); focusClipMenuItem(cur + 1); }
  else if (e.key === 'ArrowUp')   { e.preventDefault(); focusClipMenuItem(cur - 1); }
  else if (e.key === 'Home')      { e.preventDefault(); focusClipMenuItem(0); }
  else if (e.key === 'End')       { e.preventDefault(); focusClipMenuItem(btns.length - 1); }
  else if (e.key === 'Tab')       { closeClipMenu(); }
}

function onClipMenuOutside(e) {
  if (clipMenuEl && !clipMenuEl.contains(e.target)) closeClipMenu();
}

// Opened by the kebab button (anchored to the button) or by right-clicking a
// card (anchored to the pointer). `openClipMetadata` right-click is separate.
function openClipMenu(ev, slug) {
  if (ev) { ev.preventDefault(); ev.stopPropagation(); }
  closeClipMenu();
  const clip = clips.find(c => c.slug === slug);
  if (!clip) return;

  const items = clipMenuItems(clip);
  const menu = document.createElement('div');
  menu.className = 'clip-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = items.map((it, i) => `
    <button class="clip-menu-item${it.danger ? ' danger' : ''}${it.divider ? ' has-divider' : ''}"
            role="menuitem" tabindex="-1" data-idx="${i}">
      ${svgEl(it.icon, 14)}<span>${escHtml(it.label)}</span>
    </button>`).join('');
  document.body.appendChild(menu);
  clipMenuEl = menu;

  menu.querySelectorAll('.clip-menu-item').forEach((btn, i) => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const run = items[i].run;
      closeClipMenu();
      run();
    });
  });

  const btn = ev && ev.currentTarget && ev.currentTarget.classList
    && ev.currentTarget.classList.contains('clip-menu-btn') ? ev.currentTarget : null;
  clipMenuBtn = btn;
  if (btn) btn.setAttribute('aria-expanded', 'true');

  // Anchor to the pointer for a right-click, else below the kebab button.
  let x = ev && ev.clientX ? ev.clientX : 0;
  let y = ev && ev.clientY ? ev.clientY : 0;
  if ((!x && !y) && btn) {
    const rect = btn.getBoundingClientRect();
    x = rect.right; y = rect.bottom + 4;
  }
  const mw = menu.offsetWidth || 200;
  const mh = menu.offsetHeight || 240;
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - mw - 8)) + 'px';
  menu.style.top  = Math.max(8, Math.min(y, window.innerHeight - mh - 8)) + 'px';

  document.addEventListener('keydown', onClipMenuKey, true);
  setTimeout(() => document.addEventListener('pointerdown', onClipMenuOutside, true), 0);
  focusClipMenuItem(0);
}

// ── Configure-metadata modal ───────────────────────────────────────────────
let clipMetaSlug = null;
let clipMetaOrigin = 'raw';
let clipMetaReturnFocus = null;

function gameOptionsHTML() {
  const set = new Set();
  clips.forEach(c => { if (c.game) set.add(c.game); });
  (cfg.discord?.custom_games || []).forEach(g => {
    const n = (g && g.name) || (typeof g === 'string' ? g : '');
    if (n) set.add(n);
  });
  set.add('Multiple games');
  return [...set]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    .map(g => `<option value="${escAttr(g)}"></option>`).join('');
}

function syncClipMetaType() {
  document.querySelectorAll('#clip-meta-type .seg').forEach(b => {
    const on = b.dataset.origin === clipMetaOrigin;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
}
function setClipMetaType(origin) {
  clipMetaOrigin = origin === 'edited' ? 'edited' : 'raw';
  syncClipMetaType();
}

function renderClipMetaPlaylists(slug) {
  const box = document.getElementById('clip-meta-playlists');
  const customs = playlists.filter(p => p.kind === 'custom');
  if (!customs.length) {
    box.innerHTML = '<div class="clip-meta-empty">No custom playlists yet.</div>';
    return;
  }
  box.innerHTML = customs.map(p => {
    const on = (p.clip_slugs || []).includes(slug);
    return `
      <label class="clip-meta-check">
        <input type="checkbox" value="${escAttr(p.id)}" ${on ? 'checked' : ''}>
        <span class="clip-meta-check-emoji">${escHtml(p.emoji || '')}</span>
        <span class="clip-meta-check-name">${escHtml(p.name)}</span>
      </label>`;
  }).join('');
}

function renderClipMetaProvenance(clip) {
  const el = document.getElementById('clip-meta-provenance');
  const prov = clip.provenance;
  if (!prov || !Array.isArray(prov.sources) || !prov.sources.length) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  const rows = prov.sources.map(s => `
    <li>${escHtml(s.slug || s.uuid || 'source')}${s.game ? ` · ${escHtml(s.game)}` : ''}</li>`).join('');
  el.hidden = false;
  el.innerHTML = `
    <div class="field-label">Edited from${prov.game ? ` · ${escHtml(prov.game)}` : ''}</div>
    <ul class="clip-meta-sources">${rows}</ul>`;
}

function openClipMetadata(ev, slug) {
  if (ev) { ev.preventDefault(); ev.stopPropagation(); }
  closeClipMenu();
  const clip = clips.find(c => c.slug === slug);
  if (!clip) return;
  clipMetaSlug = slug;
  clipMetaReturnFocus = document.activeElement;

  document.getElementById('clip-meta-name').textContent = clip.name || slug;
  clipMetaOrigin = clip.origin === 'edited' ? 'edited' : 'raw';
  syncClipMetaType();
  const gameInput = document.getElementById('clip-meta-game');
  gameInput.value = clip.game || '';
  document.getElementById('clip-meta-games').innerHTML = gameOptionsHTML();
  renderClipMetaPlaylists(slug);
  renderClipMetaProvenance(clip);

  document.getElementById('clip-meta-modal').classList.add('open');
  document.addEventListener('keydown', onClipMetaKey, true);
  setTimeout(() => { try { gameInput.focus(); gameInput.select(); } catch (_) {} }, 0);
}

function onClipMetaKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); closeClipMetadata(); }
}

function closeClipMetadata() {
  document.getElementById('clip-meta-modal').classList.remove('open');
  document.removeEventListener('keydown', onClipMetaKey, true);
  clipMetaSlug = null;
  const el = clipMetaReturnFocus;
  clipMetaReturnFocus = null;
  if (el && document.contains(el)) { try { el.focus(); } catch (_) {} }
}

function onClipMetaBackdrop(ev) {
  if (ev.target && ev.target.id === 'clip-meta-modal') closeClipMetadata();
}

async function saveClipMetadata() {
  if (!clipMetaSlug) return;
  const slug = clipMetaSlug;
  const game = document.getElementById('clip-meta-game').value.trim();
  const ids = [...document.querySelectorAll('#clip-meta-playlists input[type="checkbox"]:checked')]
    .map(c => c.value);
  const btn = document.getElementById('clip-meta-save');
  btn.disabled = true;
  try {
    const r = await fetch(`/api/clips/${encodeURIComponent(slug)}/metadata`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game: game || null, origin: clipMetaOrigin, playlist_ids: ids }),
    });
    const d = await r.json();
    if (!d.ok) { toast(d.error || 'Could not save changes', 'err'); return; }
    // Apply the authoritative response immediately so counts + grouped/active
    // views refresh without waiting for the WebSocket echo.
    applyClipLocal(d.clip);
    applyPlaylistsLocal(d.playlists);
    rerenderAfterMetadata();
    closeClipMetadata();
    toast('Clip updated', 'ok');
  } catch (_) {
    toast('Could not save changes', 'err');
  } finally {
    btn.disabled = false;
  }
}
