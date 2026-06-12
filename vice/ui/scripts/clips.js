'use strict';
// clips.js — clip grid + cards + actions (trigger/delete/share/rename)

// ═══════════════════════════════════════════════════════════════════
// Clips — fetch + render
// ═══════════════════════════════════════════════════════════════════
async function fetchClips() {
  try {
    const r = await fetch('/api/clips');
    const d = await r.json();
    clips = d.clips || [];
    renderClips();
    renderHomeRecent();
    renderStats();
  } catch (_) {
    document.getElementById('clip-sub').textContent = 'Cannot reach daemon';
  }
}

let activePreviewVideo = null;
function stopActivePreview(resetTime = true) {
  if (!activePreviewVideo) return;
  try {
    activePreviewVideo.pause();
    if (resetTime) activePreviewVideo.currentTime = 0;
  } catch (_) {}
  const card = activePreviewVideo.closest('.clip-card');
  if (card) card.classList.remove('preview-on');
  activePreviewVideo = null;
}
function startPreview(slug) {
  const card = document.getElementById('card-' + slug);
  if (!card) return;
  const vid = card.querySelector('video.preview-video');
  if (!vid) return;
  if (activePreviewVideo && activePreviewVideo !== vid) stopActivePreview(true);
  card.classList.add('preview-on');
  activePreviewVideo = vid;
  const maybe = vid.play();
  if (maybe && typeof maybe.catch === 'function') maybe.catch(() => {});
}
function stopPreview(slug) {
  const card = document.getElementById('card-' + slug);
  if (!card) return;
  const vid = card.querySelector('video.preview-video');
  if (!vid) return;
  card.classList.remove('preview-on');
  try { vid.pause(); vid.currentTime = 0; } catch (_) {}
  if (activePreviewVideo === vid) activePreviewVideo = null;
}

function renderClips() {
  const grid  = document.getElementById('clips-grid');
  const empty = document.getElementById('clips-empty');
  const sub   = document.getElementById('clip-sub');
  const dir   = cfg.output?.directory || '~/Videos/Vice';

  const n = clips.length;
  sub.textContent = n === 0 ? 'No clips saved yet' : `${n} clip${n !== 1 ? 's' : ''} in ${dir}`;
  empty.style.display = n === 0 ? 'block' : 'none';
  grid.style.display  = n === 0 ? 'none' : 'grid';
  stopActivePreview(true);

  grid.innerHTML = clips.map(c => cardHTML(c)).join('');
  attachPreviewFailureHandlers(grid);
}

// Hover previews that cannot decode fall back to the thumbnail quietly.
// Media events fire only on the <video> itself (no capture/bubble path to
// ancestors), so handlers go on each element after every render. Missing
// codecs do not fire `error` at all: the video track is silently dropped
// and videoWidth stays 0 (issue #79).
const previewErrLogged = new Set();
function attachPreviewFailureHandlers(grid) {
  grid.querySelectorAll('video.preview-video').forEach(vid => {
    const fail = why => {
      const card = vid.closest('.clip-card');
      const slug = card ? card.id.replace(/^card-/, '') : '?';
      if (card) card.classList.remove('preview-on');
      if (!previewErrLogged.has(slug)) {
        previewErrLogged.add(slug);
        nativeLog(`video error: preview ${slug} ${why} h264=${H264_SUPPORTED}`);
      }
    };
    vid.addEventListener('error', () => {
      if (vid.getAttribute('src')) fail(mediaErrorName(vid.error));
    });
    vid.addEventListener('loadeddata', () => {
      if (vid.videoWidth === 0) fail('NO_VIDEO_TRACK');
    });
  });
}

function cardHTML(c) {
  const sizeStr = c.size     ? `${(c.size / 1048576).toFixed(1)} MB` : '';
  const resStr  = c.width    ? `${c.width}\u00d7${c.height}`         : '';
  const durStr  = c.duration ? fmtSec(Math.round(c.duration), true)  : '';
  const dateStr = c.created_at
    ? new Date(c.created_at).toLocaleDateString(undefined, {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})
    : '';
  const isNew = recentNew.has(c.slug);
  const slug  = escAttr(c.slug);
  const name  = escHtml(c.name || c.slug);

  const hoverHandlers = `onpointerenter="startPreview('${slug}')" onpointerleave="stopPreview('${slug}')"`;
  const mediaHtml = c.thumb_url
    ? `<img src="${escAttr(c.thumb_url)}" loading="lazy" alt="">
       <video class="preview-video" src="${escAttr(c.video_url)}" muted loop playsinline preload="none"></video>`
    : `<div class="thumb-placeholder">${svgEl('film', 32)}</div>`;

  const shareDisabled = !c.share_url;
  const shareBtn = `<button class="btn-pill btn-ghost-pill btn-sq" title="${shareDisabled ? 'No share URL yet' : 'Copy share link'}" ${shareDisabled ? 'disabled' : `onclick="copyLink(event, '${escAttr(c.share_url)}')"`}>${svgEl('link2')}</button>`;

  return `
  <div class="clip-card" id="card-${slug}">
    <div class="thumb-wrap" onclick="openViewer('${slug}')" ${hoverHandlers}>
      ${mediaHtml}
      <div class="thumb-play-overlay">${svgEl('play', 42)}</div>
      ${durStr ? `<div class="clip-dur-badge">${durStr}</div>` : ''}
      ${isNew  ? `<div class="clip-new-badge">NEW</div>`       : ''}
    </div>
    <div class="clip-info">
      <div class="clip-name" title="${escAttr(c.name || c.slug)}" ondblclick="startRename('${slug}', this)">${name}</div>
      <div class="clip-meta">
        ${dateStr ? `<span>${svgEl('clock', 11)}${escHtml(dateStr)}</span>` : ''}
        ${resStr  ? `<span>${svgEl('monitor', 11)}${resStr}</span>`         : ''}
        ${sizeStr ? `<span>${svgEl('hardDrive', 11)}${sizeStr}</span>`      : ''}
      </div>
    </div>
    <div class="clip-actions">
      <button class="btn-pill btn-ghost-pill" onclick="openViewer('${slug}')">${svgEl('play')} Play</button>
      <button class="btn-pill btn-ghost-pill" onclick="openTrim('${slug}', '${escAttr(c.video_url || '')}')">${svgEl('scissors')} Trim</button>
      ${shareBtn}
      <button class="btn-pill btn-ghost-pill btn-sq" title="Reveal in file manager" onclick="revealClip('${slug}')">${svgEl('folderOpen')}</button>
      <button class="btn-pill btn-ghost-pill btn-sq" title="Rename" onclick="startRename('${slug}', this)">${svgEl('pencil')}</button>
      <button class="btn-pill btn-ghost-pill btn-sq" title="Delete" onclick="delClip('${slug}')" style="color:var(--danger)">${svgEl('trash2')}</button>
    </div>
  </div>`;
}

async function triggerClip() {
  try {
    await fetch('/api/trigger', { method: 'POST' });
  } catch (_) { toast('Daemon not running', 'err'); }
}

async function delClip(slug) {
  if (!confirm('Delete this clip? This cannot be undone.')) return;
  try {
    await fetch(`/api/clips/${encodeURIComponent(slug)}`, { method: 'DELETE' });
    recentNew.delete(slug);
    clips = clips.filter(c => c.slug !== slug);
    renderClips();
    renderHomeRecent();
    renderStats();
    toast('Clip deleted', 'ok');
  } catch (_) { toast('Failed to delete', 'err'); }
}

function copyLink(ev, url) {
  if (ev) { ev.preventDefault(); ev.stopPropagation(); }
  nativeLog(`copyLink: url=${(url || '').slice(0, 60)}`);
  if (!url) return;
  copyToClipboard(url).then(ok => {
    if (ok) toast('Share link copied!', 'ok');
    else showManualCopyModal(url);
  });
}

async function revealClip(slug) {
  try {
    await fetch(`/api/clips/${encodeURIComponent(slug)}/reveal`, { method: 'POST' });
  } catch (_) { toast('Could not open file manager', 'err'); }
}

// Playback fallback for engines that cannot decode the clip in-app:
// hand the file to the system default video player.
async function openClipExternally(slug) {
  if (!slug) return;
  try {
    const r = await fetch(`/api/clips/${encodeURIComponent(slug)}/open`, { method: 'POST' });
    if (!r.ok) throw new Error(String(r.status));
    toast('Opened in system player', 'ok');
  } catch (_) { toast('Could not open system player', 'err'); }
}

// `el` is the element the user clicked. Home recent cards share ids with
// grid cards, so getElementById would resolve to the hidden home card and
// swap the rename input into a view the user cannot see (issue #99). The
// clicked element pins the rename to the card actually on screen.
function startRename(slug, el) {
  const card = el ? el.closest('.clip-card') : document.getElementById('card-' + slug);
  if (!card) return;
  const nameEl = card.querySelector('.clip-name');
  if (!nameEl) return; // rename already in progress on this card
  const current = nameEl.textContent.trim().replace(/\.mp4$/i, '');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'clip-rename-input';
  input.value = current;
  nameEl.replaceWith(input);
  input.focus(); input.select();
  let submitted = false;
  const submit = async () => {
    if (submitted) return;
    submitted = true;
    const v = input.value.trim();
    if (!v || v === current) { input.replaceWith(nameEl); return; }
    if (v.includes(' ')) { toast('Clip name cannot contain spaces', 'err'); submitted = false; input.focus(); input.select(); return; }
    try {
      const r = await fetch(`/api/clips/${encodeURIComponent(slug)}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: v }),
      });
      const data = await r.json();
      if (!data.ok) { toast(data.error || 'Rename failed', 'err'); input.replaceWith(nameEl); }
    } catch (_) { toast('Rename failed', 'err'); input.replaceWith(nameEl); }
  };
  const cancel = () => { if (!submitted) { submitted = true; input.replaceWith(nameEl); } };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); submit(); }
    if (e.key === 'Escape') { cancel(); }
  });
  input.addEventListener('blur', submit);
}
