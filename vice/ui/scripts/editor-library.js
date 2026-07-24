'use strict';
// editor-library.js — editor left panel: clip library, effects, text presets

let edTab = 'library';
let edLibQuery = '';
let edLibGame = 'all';
let edLibType = 'all';   // all | raw | edited (persisted in ui_state.json)
let edDrag = null;       // {kind: 'clip'|'fx'|'text', id} while dragging from the panel
let edDragGhost = null;
const ED_GAME_UNTAGGED = '__untagged__';

const ED_LIB_HINTS = {
  library: 'Drag a clip onto the timeline · double-click to append',
  effects: 'Drag an effect onto a clip, or between two clips',
  text:    'Drag a title onto the preview or the T1 lane',
};

function edSetTab(tab) {
  edTab = tab;
  edRenderLibrary();
}

function edLibSearch(v) {
  edLibQuery = v || '';
  edRenderLibraryList();
}

function edLibGameChanged(value) {
  edLibGame = value || 'all';
  edRenderLibraryList();
}

function edLibTypeChanged(value) {
  const modes = new Set(['all', 'raw', 'edited']);
  edLibType = modes.has(value) ? value : 'all';
  persistClipUiState({editor_type_filter: edLibType});
  edRenderLibraryList();
}

// Restore the persisted editor library type filter (called from bootstrap).
function edApplyPersistedType(state) {
  const modes = new Set(['all', 'raw', 'edited']);
  const value = state && state.editor_type_filter;
  edLibType = modes.has(value) ? value : 'all';
  const select = document.getElementById('ed-lib-type');
  if (select) select.value = edLibType;
}

function edLibraryGames() {
  return [...new Set(
    clips.filter(clip => clip.duration > 0)
      .map(clip => String(clip.game || '').trim())
      .filter(Boolean),
  )].sort((a, b) => a.localeCompare(b, undefined, {sensitivity: 'base'}));
}

function edSyncLibraryGameControl() {
  const select = document.getElementById('ed-lib-game');
  if (!select) return;
  const games = edLibraryGames();
  const hasUntagged = clips.some(clip => clip.duration > 0 && !String(clip.game || '').trim());
  const valid = edLibGame === 'all'
    || games.includes(edLibGame)
    || (edLibGame === ED_GAME_UNTAGGED && hasUntagged);
  if (!valid) edLibGame = 'all';

  select.innerHTML = '';
  select.add(new Option('All games', 'all'));
  games.forEach(game => select.add(new Option(game, game)));
  if (hasUntagged) select.add(new Option('Untagged', ED_GAME_UNTAGGED));
  select.value = edLibGame;
  const typeSelect = document.getElementById('ed-lib-type');
  if (typeSelect) typeSelect.value = edLibType;
}

function edFilteredLibraryClips() {
  const query = edLibQuery.trim().toLowerCase();
  return clips.filter(clip => {
    if (!(clip.duration > 0)) return false;
    if (edLibType !== 'all') {
      const origin = clip.origin === 'edited' ? 'edited' : 'raw';
      if (origin !== edLibType) return false;
    }
    const game = String(clip.game || '').trim();
    if (edLibGame === ED_GAME_UNTAGGED && game) return false;
    if (edLibGame !== 'all' && edLibGame !== ED_GAME_UNTAGGED && game !== edLibGame) return false;
    return !query || `${clip.name} ${game}`.toLowerCase().includes(query);
  });
}

function edRenderLibrary() {
  const tabs = ['library', 'effects', 'text'];
  document.querySelectorAll('.ed-tab').forEach(el =>
    el.classList.toggle('active', el.dataset.tab === edTab));
  const glider = document.getElementById('ed-tab-glider');
  glider.style.left = (tabs.indexOf(edTab) * 33.333) + '%';
  document.getElementById('ed-lib-controls').hidden = edTab !== 'library';
  if (edTab === 'library') edSyncLibraryGameControl();
  setText('ed-lib-hint', ED_LIB_HINTS[edTab]);
  edRenderLibraryList();
}

function edRenderLibraryList() {
  const scroll = document.getElementById('ed-lib-scroll');
  if (edTab === 'library') {
    const q = edLibQuery.trim().toLowerCase();
    const filtered = q || edLibGame !== 'all' || edLibType !== 'all';
    const list = edFilteredLibraryClips();
    const cards = list.map(c => {
      const slug = escAttr(c.slug);
      const media = c.thumb_url
        ? `<img src="${escAttr(c.thumb_url)}" loading="lazy" alt="" draggable="false">`
        : `<div class="ed-lib-ph">${svgEl('film', 24)}</div>`;
      const meta = [c.width ? `${c.width}×${c.height}` : '',
                    c.size ? `${(c.size / 1048576).toFixed(1)} MB` : ''].filter(Boolean).join(' · ');
      return `
      <div class="ed-lib-clip" draggable="true" title="Drag to the timeline · double-click to append"
           ondragstart="edDragStart(event, 'clip', '${slug}')" ondragend="edDragEnd()"
           ondblclick="edQuickAdd('${slug}')">
        <div class="ed-lib-thumb">
          ${media}
          ${c.game ? `<span class="ed-lib-game">${escHtml(c.game.toUpperCase())}</span>` : ''}
          <span class="ed-lib-dur">${edFmtS(c.duration)}</span>
        </div>
        <div class="ed-lib-name">${escHtml(c.name || c.slug)}</div>
        <div class="ed-lib-meta">${escHtml(meta)}</div>
      </div>`;
    }).join('');
    scroll.innerHTML = `<div class="ed-lib-grid">${cards ||
      `<div class="ed-lib-empty">${filtered ? 'No clips match<br><span>Adjust the search or game filter.</span>'
                                           : 'No clips yet<br><span>Save some gameplay first.</span>'}</div>`}</div>`;
  } else if (edTab === 'effects') {
    scroll.innerHTML = ED_FX.map(fx => `
      <div class="ed-fx-row" draggable="true"
           ondragstart="edDragStart(event, 'fx', '${fx.id}')" ondragend="edDragEnd()">
        <span class="ed-fx-icon">${edGlyph(fx.glyph, 16)}</span>
        <div class="ed-fx-copy">
          <div class="ed-fx-name">${fx.name}</div>
          <div class="ed-fx-desc">${fx.desc}</div>
        </div>
        <span class="ed-fx-len">${fx.len.toFixed(1)}s</span>
      </div>`).join('');
  } else {
    scroll.innerHTML = ED_TEXT_PRESETS.map(p => `
      <div class="ed-text-row" draggable="true"
           ondragstart="edDragStart(event, 'text', '${p.id}')" ondragend="edDragEnd()">
        <div class="ed-text-hd">
          <span class="ed-text-kind">${p.name.toUpperCase()}</span>
          <span>${ED_FONTS[p.font].label}</span>
        </div>
        <div class="ed-text-sample" style="font-family:${ED_FONTS[p.font].stack};font-weight:${p.weight};font-size:${Math.min(20, p.size / 2.8)}px;color:${p.color};${p.font === 'display' ? 'letter-spacing:-.02em;' : ''}">${escHtml(p.sample)}</div>
      </div>`).join('');
  }
}

function edGlyph(paths, size = 14) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

function edDragStart(ev, kind, id) {
  edDrag = { kind, id };
  ev.dataTransfer.effectAllowed = 'copy';
  ev.dataTransfer.setData('text/plain', `vice-ed:${kind}:${id}`);

  const ghost = document.createElement('div');
  if (kind === 'clip') {
    const c = clips.find(x => x.slug === id);
    ghost.className = 'clip-drag-ghost';
    ghost.innerHTML = c && c.thumb_url
      ? `<img src="${escAttr(c.thumb_url)}" alt=""><span class="clip-drag-ghost-name">${escHtml(c.name || id)}</span>`
      : `<span class="clip-drag-ghost-ph">${svgEl('film', 14)}</span><span class="clip-drag-ghost-name">${escHtml(id)}</span>`;
  } else {
    const label = kind === 'fx' ? edFx(id).name : ED_TEXT_PRESETS.find(x => x.id === id).name;
    ghost.className = 'clip-drag-ghost';
    ghost.innerHTML = `<span class="clip-drag-ghost-name">${escHtml(label)}</span>`;
  }
  document.body.appendChild(ghost);
  edDragGhost = ghost;
  ev.dataTransfer.setDragImage(ghost, 24, 20);
}

function edDragEnd() {
  edDrag = null;
  if (edDragGhost) { edDragGhost.remove(); edDragGhost = null; }
  edClearDropHints();
}
