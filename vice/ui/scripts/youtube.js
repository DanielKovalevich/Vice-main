'use strict';
// youtube.js — connector settings and clip upload workflow

let youtubeConnectorDrafts = [];
let youtubeUploadSlug = null;
let youtubeUploadJob = null;
let youtubeElapsedTimer = null;
const youtubeCopiedJobs = new Set();
const youtubeCollapsedConnectors = new Set();

function youtubeConfig() {
  return cfg.youtube || { executable: 'youtubeuploader', connectors: [] };
}

function splitYouTubeList(value) {
  return String(value || '').split(/[,\n]/).map(v => v.trim()).filter(Boolean);
}

function renderYouTubeSettings() {
  const yt = youtubeConfig();
  const executable = document.getElementById('s-youtube-executable');
  if (executable) executable.value = yt.executable || 'youtubeuploader';
  youtubeConnectorDrafts = (Array.isArray(yt.connectors) ? yt.connectors : [])
    .map(connector => ({
      ...connector,
      tags: [...(connector.tags || [])],
      playlist_ids: [...(connector.playlist_ids || [])],
    }));
  renderYouTubeConnectorCards();
}

function renderYouTubeConnectorCards() {
  const list = document.getElementById('yt-connector-list');
  if (!list) return;
  if (!youtubeConnectorDrafts.length) {
    list.innerHTML = `
      <div class="yt-connectors-empty">
        No connectors yet. Add one for CS2, Deadlock, or any other upload preset.
      </div>`;
    renderYouTubeConnectorStatuses();
    return;
  }
  list.innerHTML = youtubeConnectorDrafts.map((connector, index) => {
    const privacy = connector.privacy || 'unlisted';
    const collapsed = youtubeCollapsedConnectors.has(connector.id);
    const connectorName = connector.name || `Connector ${index + 1}`;
    return `
      <div class="yt-connector-card${collapsed ? ' collapsed' : ''}" data-connector-id="${escAttr(connector.id)}">
        <div class="yt-connector-head">
          <button class="yt-connector-disclosure" type="button"
                  aria-expanded="${collapsed ? 'false' : 'true'}"
                  aria-controls="yt-connector-body-${escAttr(connector.id)}"
                  aria-label="${collapsed ? 'Expand' : 'Collapse'} ${escAttr(connectorName)} connector"
                  onclick="toggleYouTubeConnector('${escAttr(connector.id)}')">
            <svg class="yt-connector-chevron" viewBox="0 0 24 24" width="15" height="15"
                 fill="none" stroke="currentColor" stroke-width="2"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m6 9 6 6 6-6"/>
            </svg>
            <span class="yt-connector-summary">
              <strong>${escHtml(connectorName)}</strong>
              <span class="mono">${escHtml(connector.id)}</span>
            </span>
          </button>
          <button class="btn-pill btn-danger-pill btn-sm" type="button"
                  onclick="removeYouTubeConnector('${escAttr(connector.id)}')">Remove</button>
        </div>
        <div class="yt-connector-body" id="yt-connector-body-${escAttr(connector.id)}">
          <div class="yt-connector-grid">
            <label><span>Name</span>
              <input type="text" class="ytc-name" maxlength="80" value="${escAttr(connector.name || '')}" placeholder="CS2">
            </label>
            <label><span>Privacy</span>
              <select class="ytc-privacy">
                <option value="unlisted"${privacy === 'unlisted' ? ' selected' : ''}>Unlisted</option>
                <option value="private"${privacy === 'private' ? ' selected' : ''}>Private</option>
                <option value="public"${privacy === 'public' ? ' selected' : ''}>Public</option>
              </select>
            </label>
            <label class="yt-wide"><span>Title template</span>
              <input type="text" class="ytc-title" maxlength="200" value="${escAttr(connector.title_template || '$filename')}"
                    placeholder="$filename" spellcheck="false">
              <small><code>$filename</code>, <code>$game</code>, <code>$date</code>, and <code>$time</code> are replaced for each clip.</small>
            </label>
            <label class="yt-wide"><span>Description</span>
              <textarea class="ytc-description" rows="3" maxlength="5000">${escHtml(connector.description || '')}</textarea>
            </label>
            <label><span>Tags</span>
              <input type="text" class="ytc-tags" value="${escAttr((connector.tags || []).join(', '))}" placeholder="CS2, clip">
            </label>
            <label><span>Playlist IDs</span>
              <textarea class="ytc-playlists mono" rows="2" placeholder="One per line">${escHtml((connector.playlist_ids || []).join('\n'))}</textarea>
            </label>
            <label class="yt-wide"><span>OAuth client secrets</span>
              <input type="text" class="ytc-secrets mono" value="${escAttr(connector.secrets_path || '')}"
                    placeholder="~/youtube/client_secrets.json" spellcheck="false">
            </label>
            <label class="yt-wide"><span>OAuth token cache</span>
              <input type="text" class="ytc-cache mono" value="${escAttr(connector.cache_path || '')}"
                    placeholder="~/youtube/request.token" spellcheck="false">
            </label>
            <label><span>OAuth callback port</span>
              <input type="number" class="ytc-port" min="1" max="65535" value="${Number(connector.oauth_port) || 8080}">
            </label>
            <label class="yt-connector-notify">
              <span><strong>Notify subscribers</strong><small>Off is safer for frequent clips.</small></span>
              <span class="toggle"><input type="checkbox" class="ytc-notify"${connector.notify ? ' checked' : ''}><span class="toggle-track"></span></span>
            </label>
          </div>
          <div class="yt-connector-status" id="yt-connector-status-${escAttr(connector.id)}"></div>
        </div>
      </div>`;
  }).join('');
  renderYouTubeConnectorStatuses();
}

function toggleYouTubeConnector(id) {
  const card = document.querySelector(`.yt-connector-card[data-connector-id="${id}"]`);
  if (!card) return;
  const collapsed = card.classList.toggle('collapsed');
  if (collapsed) youtubeCollapsedConnectors.add(id);
  else youtubeCollapsedConnectors.delete(id);

  const disclosure = card.querySelector('.yt-connector-disclosure');
  const summaryName = card.querySelector('.yt-connector-summary strong');
  const name = card.querySelector('.ytc-name')?.value.trim()
    || summaryName?.textContent
    || 'YouTube';
  if (summaryName) summaryName.textContent = name;
  disclosure.setAttribute('aria-expanded', String(!collapsed));
  disclosure.setAttribute(
    'aria-label',
    `${collapsed ? 'Expand' : 'Collapse'} ${name} connector`
  );
}

function collectYouTubeConnectorDrafts() {
  const cards = [...document.querySelectorAll('.yt-connector-card')];
  youtubeConnectorDrafts = cards.map(card => ({
    id: card.dataset.connectorId,
    name: card.querySelector('.ytc-name').value.trim(),
    secrets_path: card.querySelector('.ytc-secrets').value.trim() || null,
    cache_path: card.querySelector('.ytc-cache').value.trim() || null,
    oauth_port: Number(card.querySelector('.ytc-port').value || 8080),
    title_template: card.querySelector('.ytc-title').value.trim() || '$filename',
    description: card.querySelector('.ytc-description').value,
    privacy: card.querySelector('.ytc-privacy').value,
    tags: splitYouTubeList(card.querySelector('.ytc-tags').value),
    playlist_ids: splitYouTubeList(card.querySelector('.ytc-playlists').value),
    notify: card.querySelector('.ytc-notify').checked,
  }));
  return youtubeConnectorDrafts;
}

function collectYouTubeSettings() {
  return {
    executable: document.getElementById('s-youtube-executable')?.value.trim() || 'youtubeuploader',
    connectors: collectYouTubeConnectorDrafts(),
  };
}

function addYouTubeConnector() {
  collectYouTubeConnectorDrafts();
  const id = `yt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  youtubeConnectorDrafts.push({
    id,
    name: '',
    secrets_path: null,
    cache_path: null,
    oauth_port: 8080,
    title_template: '$filename',
    description: '',
    privacy: 'unlisted',
    tags: [],
    playlist_ids: [],
    notify: false,
  });
  renderYouTubeConnectorCards();
  document.querySelector(`[data-connector-id="${id}"] .ytc-name`)?.focus();
}

function removeYouTubeConnector(id) {
  collectYouTubeConnectorDrafts();
  youtubeCollapsedConnectors.delete(id);
  youtubeConnectorDrafts = youtubeConnectorDrafts.filter(item => item.id !== id);
  renderYouTubeConnectorCards();
}

function renderYouTubeConnectorStatuses() {
  const box = document.getElementById('yt-settings-status');
  if (!box) return;
  const statuses = youtubeStatus.connectors || [];
  if (!youtubeConnectorDrafts.length) {
    box.textContent = 'The uploader remains optional until you add a connector.';
  } else if (!statuses.length) {
    box.textContent = 'Save settings to check the uploader and OAuth files.';
  } else {
    const ready = statuses.filter(item => item.available).length;
    box.textContent = `${ready} of ${statuses.length} connector${statuses.length === 1 ? '' : 's'} ready`;
  }

  for (const connector of youtubeConnectorDrafts) {
    const el = document.getElementById(`yt-connector-status-${connector.id}`);
    if (!el) continue;
    const status = statuses.find(item => item.id === connector.id);
    el.className = 'yt-connector-status';
    if (!status) {
      el.textContent = 'Save settings to check this connector.';
    } else if (status.available) {
      el.classList.add('ready');
      el.textContent = `Ready · ${status.executable}`;
    } else {
      el.classList.add('error');
      el.textContent = status.error || 'Connector is not ready.';
    }
  }
}

async function refreshYouTubeStatus() {
  try {
    const response = await fetch('/api/youtube/status');
    if (!response.ok) throw new Error(String(response.status));
    youtubeStatus = await response.json();
  } catch (_) {
    youtubeStatus = { connectors: [], active: null };
  }
  renderYouTubeConnectorStatuses();
  const active = youtubeStatus.active;
  const belongsToOpenClip = youtubeUploadSlug && active?.slug === youtubeUploadSlug;
  if (belongsToOpenClip && active.status === 'uploading') {
    showYouTubeUploadBusy(active);
  } else if (
    belongsToOpenClip
    && ['done', 'partial', 'error', 'canceled'].includes(active.status)
  ) {
    showYouTubeUploadResult(active);
  } else {
    updateYouTubeUploadReadiness();
  }
  return youtubeStatus;
}

function youtubeConnectorById(id) {
  return (youtubeConfig().connectors || []).find(item => item.id === id) || null;
}

function youtubeReadinessById(id) {
  return (youtubeStatus.connectors || []).find(item => item.id === id) || null;
}

function renderYouTubeTitle(template, clip) {
  const now = new Date();
  return String(template || '$filename')
    .replaceAll('$filename', clip.slug || '')
    .replaceAll('$game', clip.game || '')
    .replaceAll('$date', `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`)
    .replaceAll('$time', String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0'))
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

function openYouTubeSettings() {
  nav('settings');
  requestAnimationFrame(() => {
    const rail = document.querySelector('[data-rail="youtube"]');
    if (rail) rail.click();
  });
}

function openYouTubeUpload(slug) {
  const clip = clips.find(item => item.slug === slug);
  if (!clip) return;
  const connectors = youtubeConfig().connectors || [];
  if (!connectors.length) {
    openYouTubeSettings();
    toast('Add and save a YouTube connector first', 'warn');
    return;
  }

  youtubeUploadSlug = slug;
  youtubeUploadJob = null;
  setText('yt-upload-clip', clip.name || slug);
  const select = document.getElementById('yt-upload-connector');
  select.innerHTML = connectors.map(item =>
    `<option value="${escAttr(item.id)}">${escHtml(item.name)}</option>`
  ).join('');

  const remembered = localStorage.getItem('vice-youtube-connector');
  const gameMatch = connectors.find(item =>
    clip.game && item.name.toLowerCase() === clip.game.toLowerCase()
  );
  const selected = connectors.find(item => item.id === remembered) || gameMatch || connectors[0];
  select.value = selected.id;
  populateYouTubeUploadForm(selected);
  showYouTubeUploadForm();
  document.getElementById('yt-upload-modal').classList.add('open');

  const active = youtubeStatus.active;
  if (active?.status === 'uploading' && active.slug === slug) {
    showYouTubeUploadBusy(active);
  }
  refreshYouTubeStatus();
}

function closeYouTubeUpload() {
  document.getElementById('yt-upload-modal').classList.remove('open');
  stopYouTubeElapsed();
}

function onYouTubeUploadBackdrop(event) {
  if (event.target.id === 'yt-upload-modal') closeYouTubeUpload();
}

function onYouTubeUploadConnectorChange() {
  const id = document.getElementById('yt-upload-connector').value;
  localStorage.setItem('vice-youtube-connector', id);
  const connector = youtubeConnectorById(id);
  if (connector) populateYouTubeUploadForm(connector);
}

function populateYouTubeUploadForm(connector) {
  const clip = clips.find(item => item.slug === youtubeUploadSlug);
  if (!clip || !connector) return;
  document.getElementById('yt-upload-title').value =
    renderYouTubeTitle(connector.title_template, clip);
  document.getElementById('yt-upload-description').value = connector.description || '';
  document.getElementById('yt-upload-privacy').value = connector.privacy || 'unlisted';
  document.getElementById('yt-upload-tags').value = (connector.tags || []).join(', ');
  document.getElementById('yt-upload-playlists').value = (connector.playlist_ids || []).join('\n');
  document.getElementById('yt-upload-notify').checked = !!connector.notify;
  updateYouTubeUploadReadiness();
}

function updateYouTubeUploadReadiness() {
  const note = document.getElementById('yt-upload-readiness');
  const start = document.getElementById('yt-upload-start');
  if (!note || !start || !youtubeUploadSlug) return;
  const id = document.getElementById('yt-upload-connector').value;
  const readiness = youtubeReadinessById(id);
  const active = youtubeStatus.active;
  const anotherBusy = active?.status === 'uploading' && active.slug !== youtubeUploadSlug;

  note.className = 'yt-field-note';
  start.disabled = false;
  if (anotherBusy) {
    note.classList.add('error');
    note.textContent = `${active.connector_name || 'Another connector'} is already uploading ${active.slug}.`;
    start.disabled = true;
  } else if (!readiness) {
    note.textContent = 'Checking uploader and OAuth files...';
  } else if (!readiness.available) {
    note.classList.add('error');
    note.textContent = readiness.error || 'This connector is not ready.';
    start.disabled = true;
  } else {
    note.classList.add('ready');
    note.textContent = 'Ready to upload.';
  }
}

function showYouTubeUploadForm() {
  document.getElementById('yt-upload-form').hidden = false;
  document.getElementById('yt-upload-busy').hidden = true;
  document.getElementById('yt-upload-result').hidden = true;
  document.getElementById('yt-upload-actions-form').hidden = false;
  document.getElementById('yt-upload-actions-busy').hidden = true;
  document.getElementById('yt-upload-actions-result').hidden = true;
  setText('yt-upload-footer-note', 'The clip stays in your Vice library.');
  stopYouTubeElapsed();
}

function resetYouTubeUploadForm() {
  youtubeUploadJob = null;
  const connector = youtubeConnectorById(
    document.getElementById('yt-upload-connector').value
  );
  if (connector) populateYouTubeUploadForm(connector);
  showYouTubeUploadForm();
  updateYouTubeUploadReadiness();
}

async function startYouTubeUpload() {
  const connectorId = document.getElementById('yt-upload-connector').value;
  const title = document.getElementById('yt-upload-title').value.trim();
  if (!title) {
    toast('Give the YouTube video a title', 'err');
    return;
  }
  const button = document.getElementById('yt-upload-start');
  button.disabled = true;
  try {
    const response = await fetch(`/api/clips/${encodeURIComponent(youtubeUploadSlug)}/youtube`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connector_id: connectorId,
        title,
        description: document.getElementById('yt-upload-description').value,
        privacy: document.getElementById('yt-upload-privacy').value,
        tags: splitYouTubeList(document.getElementById('yt-upload-tags').value),
        playlist_ids: splitYouTubeList(document.getElementById('yt-upload-playlists').value),
        notify: document.getElementById('yt-upload-notify').checked,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      if (data.active?.status === 'uploading') youtubeStatus.active = data.active;
      throw new Error(data.error || 'YouTube upload could not start');
    }
    youtubeUploadJob = data.job;
    youtubeStatus.active = data.job;
    showYouTubeUploadBusy(data.job);
  } catch (error) {
    toast(error?.message || 'YouTube upload could not start', 'err');
    updateYouTubeUploadReadiness();
  } finally {
    button.disabled = false;
  }
}

function showYouTubeUploadBusy(job) {
  youtubeUploadJob = job;
  youtubeStatus.active = job;
  if (youtubeUploadSlug !== job.slug) return;
  document.getElementById('yt-upload-form').hidden = true;
  document.getElementById('yt-upload-busy').hidden = false;
  document.getElementById('yt-upload-result').hidden = true;
  document.getElementById('yt-upload-actions-form').hidden = true;
  document.getElementById('yt-upload-actions-busy').hidden = false;
  document.getElementById('yt-upload-actions-result').hidden = true;
  setText('yt-busy-sub', `${job.connector_name || 'YouTube'} · ${job.title || job.slug}`);
  setText('yt-upload-footer-note', 'You can hide this window; the upload will continue.');
  startYouTubeElapsed(job.started_at);
}

function startYouTubeElapsed(startedAt) {
  stopYouTubeElapsed();
  const started = new Date(startedAt || Date.now()).getTime();
  const update = () => {
    const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
    setText('yt-upload-elapsed', `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`);
  };
  update();
  youtubeElapsedTimer = setInterval(update, 1000);
}

function stopYouTubeElapsed() {
  if (youtubeElapsedTimer) clearInterval(youtubeElapsedTimer);
  youtubeElapsedTimer = null;
}

async function cancelYouTubeUpload() {
  const jobId = youtubeUploadJob?.job_id;
  if (!jobId) return;
  const button = document.getElementById('yt-upload-cancel');
  button.disabled = true;
  button.textContent = 'Canceling...';
  try {
    const response = await fetch(`/api/youtube/uploads/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
    });
    if (!response.ok) throw new Error('Upload is no longer running');
  } catch (error) {
    toast(error?.message || 'Could not cancel upload', 'err');
  } finally {
    button.disabled = false;
    button.textContent = 'Cancel upload';
  }
}

function onYouTubeUploadStarted(message) {
  youtubeStatus.active = message;
  if (youtubeUploadSlug === message.slug) showYouTubeUploadBusy(message);
}

function onYouTubeUploadDone(message) {
  youtubeStatus.active = message;
  stopYouTubeElapsed();
  if (youtubeUploadSlug === message.slug) showYouTubeUploadResult(message);
  if (!youtubeCopiedJobs.has(message.job_id)) {
    youtubeCopiedJobs.add(message.job_id);
    copyToClipboard(message.url).then(ok => {
      if (!ok) showManualCopyModal(message.url);
    });
  }
  if (message.partial) {
    const detail = message.canceled
      ? 'Video finished uploading before cancellation. The URL was copied.'
      : 'Video uploaded, but a post-upload step failed. The URL was copied.';
    toast(detail, 'warn');
  } else {
    toast('YouTube upload complete. URL copied!', 'ok');
  }
}

function onYouTubeUploadError(message) {
  youtubeStatus.active = message;
  stopYouTubeElapsed();
  if (youtubeUploadSlug === message.slug) showYouTubeUploadResult(message);
  toast(message.error || 'YouTube upload failed', message.canceled ? 'warn' : 'err');
}

function showYouTubeUploadResult(result) {
  youtubeUploadJob = result;
  document.getElementById('yt-upload-form').hidden = true;
  document.getElementById('yt-upload-busy').hidden = true;
  document.getElementById('yt-upload-result').hidden = false;
  document.getElementById('yt-upload-actions-form').hidden = true;
  document.getElementById('yt-upload-actions-busy').hidden = true;
  document.getElementById('yt-upload-actions-result').hidden = false;
  const hasUrl = !!result.url;
  document.getElementById('yt-result-open').hidden = !hasUrl;
  document.getElementById('yt-result-copy').hidden = !hasUrl;
  document.getElementById('yt-result-url').hidden = !hasUrl;
  document.getElementById('yt-result-url').value = result.url || '';
  const restart = document.getElementById('yt-result-new');
  restart.hidden = !!result.partial;
  restart.textContent = hasUrl ? 'New upload' : 'Try again';

  const icon = document.getElementById('yt-result-icon');
  const diagnostic = document.getElementById('yt-result-diagnostic');
  if (hasUrl && result.partial) {
    icon.className = 'yt-result-icon partial';
    icon.innerHTML = svgEl('alertCircle', 24);
    setText(
      'yt-result-title',
      result.canceled ? 'Video uploaded before cancellation' : 'Video uploaded, playlist step failed'
    );
    setText(
      'yt-result-sub',
      result.canceled
        ? 'The video already exists on YouTube. Do not upload it again; use the URL below.'
        : 'The video already exists on YouTube. Do not upload it again. Use the URL below and fix the playlist manually.'
    );
    setText('yt-upload-footer-note', 'Partial success · the video exists on YouTube');
    diagnostic.textContent = result.warning || '';
    diagnostic.hidden = !result.warning;
  } else if (hasUrl) {
    icon.className = 'yt-result-icon success';
    icon.innerHTML = svgEl('checkCircle2', 24);
    setText('yt-result-title', 'Upload complete');
    setText('yt-result-sub', 'The YouTube URL has been copied to your clipboard.');
    setText('yt-upload-footer-note', 'Upload complete');
    diagnostic.hidden = true;
  } else {
    icon.className = 'yt-result-icon error';
    icon.innerHTML = svgEl('alertCircle', 24);
    setText('yt-result-title', result.canceled ? 'Upload canceled' : 'Upload failed');
    setText('yt-result-sub', result.canceled
      ? 'No YouTube video ID was returned.'
      : 'youtubeuploader did not return a video ID.');
    setText('yt-upload-footer-note', result.canceled ? 'Canceled' : 'Upload failed');
    diagnostic.textContent = result.error || '';
    diagnostic.hidden = !result.error;
  }
}

function copyYouTubeResult() {
  const url = youtubeUploadJob?.url;
  if (!url) return;
  copyToClipboard(url).then(ok => {
    if (ok) toast('YouTube URL copied!', 'ok');
    else showManualCopyModal(url);
  });
}

function openYouTubeResult() {
  const url = youtubeUploadJob?.url;
  if (!url) return;
  if (typeof openExternal === 'function') openExternal(url);
  else window.open(url, '_blank', 'noopener');
}
