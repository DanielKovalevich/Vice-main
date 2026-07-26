'use strict';
// fireshare.js — FireShare settings + explicit clip publish modal

let fireshareStatus = { configured: false, token_configured: false, active: [] };
let fireshareModalSlug = null;
// Guards the Cancel-upload button against duplicate clicks while a cancel
// request is in flight; cleared in the `finally` below regardless of outcome.
let fireshareCancelPending = false;
const FIRE_SHARE_FOLDER_NAME_RE = /^[A-Za-z0-9_-]{1,128}$/;
const fireshareFolderDirectory = {
  state: 'idle',
  defaultFolder: '',
  folders: [],
  error: '',
  source: '',
  request: null,
  reloadPending: false,
  generation: 0,
};
const fireshareFolderPickers = {
  settings: { value: '', query: '', mode: 'existing', touched: false, open: false, serverDefault: false },
  publish: { value: '', query: '', mode: 'existing', touched: false, open: false, serverDefault: false },
};

// Some non-JSON failure (proxy error page, plain-text 5xx, etc.) can reach
// the client instead of the expected envelope; `r.json()` throwing a
// SyntaxError must not surface as a raw "Unexpected token" message.
async function safeJsonResponse(r) {
  try {
    return await r.json();
  } catch (_) {
    return { ok: false, error: `Unexpected response from server (HTTP ${r.status})` };
  }
}

// Robust JSON parser for the folder-picker code paths below: reads the raw
// text first so a non-JSON response (proxy error page, plain-text 5xx)
// raises a clear message instead of a raw "Unexpected token" SyntaxError.
async function fireShareResponseJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_) {
    const contentType = String(response.headers?.get?.('Content-Type') || '').toLowerCase();
    const plainText = contentType.includes('text/plain')
      ? text.trim().replace(/\s+/g, ' ').slice(0, 240)
      : '';
    const status = [response.status, response.statusText].filter(Boolean).join(' ');
    throw new Error(plainText || `FireShare request returned ${status || 'a non-JSON response'}`);
  }
}

function fireShareConfig() {
  return cfg.fireshare || {
    base_url: '',
    default_privacy: 'server_default',
    default_folder: '',
    default_title_template: '$filename',
    require_https: true,
    token_configured: false,
  };
}

function fireShareFolderIds(kind) {
  const base = kind === 'settings' ? 's-fireshare-folder' : 'fireshare-publish-folder';
  return {
    value: kind === 'settings' ? 's-fireshare-default-folder' : 'fireshare-publish-folder',
    search: `${base}-search`,
    list: `${base}-list`,
    status: `${base}-status`,
    retry: `${base}-retry`,
    create: `${base}-create`,
    newName: `${base}-new`,
    error: `${base}-error`,
  };
}

function fireShareFolderValidationMessage(value) {
  return FIRE_SHARE_FOLDER_NAME_RE.test(String(value || '').trim())
    ? ''
    : 'Use 1-128 letters, numbers, underscores, or hyphens.';
}

function initializeFireShareFolderPicker(kind, value, serverDefault = false) {
  const picker = fireshareFolderPickers[kind];
  const normalized = String(value || '').trim();
  picker.value = normalized;
  picker.query = normalized;
  picker.mode = 'existing';
  picker.touched = false;
  picker.open = false;
  picker.serverDefault = !!serverDefault;
  const newInput = document.getElementById(fireShareFolderIds(kind).newName);
  if (newInput) newInput.value = '';
  renderFireShareFolderPicker(kind);
}

function fireShareFolderOptions(kind) {
  const values = [...fireshareFolderDirectory.folders];
  if (
    kind === 'publish'
    && fireshareFolderDirectory.defaultFolder
    && !values.includes(fireshareFolderDirectory.defaultFolder)
  ) {
    values.unshift(fireshareFolderDirectory.defaultFolder);
  }
  return values;
}

function renderFireShareFolderPicker(kind) {
  const picker = fireshareFolderPickers[kind];
  const ids = fireShareFolderIds(kind);
  const valueInput = document.getElementById(ids.value);
  const search = document.getElementById(ids.search);
  const list = document.getElementById(ids.list);
  const status = document.getElementById(ids.status);
  const retry = document.getElementById(ids.retry);
  const create = document.getElementById(ids.create);
  if (valueInput) valueInput.value = picker.value;
  if (search && document.activeElement !== search) search.value = picker.query;
  if (create) create.hidden = picker.mode !== 'create';

  const query = picker.query.trim().toLowerCase();
  const options = fireShareFolderOptions(kind).filter(
    folder => !query || folder.toLowerCase().includes(query),
  );
  if (list) {
    const useDefault = kind === 'settings' && (!query || 'use fireshare default'.includes(query));
    const rows = [];
    if (useDefault) {
      const label = fireshareFolderDirectory.defaultFolder
        ? `Use FireShare default (${fireshareFolderDirectory.defaultFolder})`
        : 'Use FireShare default';
      rows.push(
        `<button type="button" class="fireshare-folder-option" role="option" aria-selected="${picker.value === ''}" onclick="selectFireShareFolder('${kind}', '')">${escHtml(label)}</button>`,
      );
    }
    for (const folder of options) {
      const suffix = folder === fireshareFolderDirectory.defaultFolder ? ' (FireShare default)' : '';
      rows.push(
        `<button type="button" class="fireshare-folder-option mono" role="option" aria-selected="${picker.value === folder}" onclick="selectFireShareFolder('${kind}', '${folder}')">${escHtml(folder + suffix)}</button>`,
      );
    }
    list.innerHTML = picker.mode === 'create' || !picker.open ? '' : rows.join('');
  }

  if (retry) retry.hidden = fireshareFolderDirectory.state !== 'error';
  if (search) {
    const expanded = picker.open && picker.mode !== 'create' && !!list?.children?.length;
    search.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }
  if (!status) return;
  status.className = 'fireshare-folder-status';
  if (picker.mode === 'create') {
    status.textContent = 'New folders are created by FireShare when you publish.';
  } else if (fireshareFolderDirectory.state === 'loading') {
    status.textContent = 'Loading FireShare folders...';
  } else if (fireshareFolderDirectory.state === 'error') {
    status.textContent = `Folders unavailable: ${fireshareFolderDirectory.error} You can retry or create a folder manually.`;
    status.classList.add('warn');
  } else if (fireshareFolderDirectory.state === 'ready' && !options.length && query) {
    status.textContent = 'No matching existing folder. Choose Create new folder to use this name.';
  } else if (picker.value) {
    const isExisting = fireShareFolderOptions(kind).includes(picker.value);
    status.textContent = `${isExisting ? 'Selected folder' : 'New folder'}: ${picker.value}`;
  } else {
    status.textContent = kind === 'settings'
      ? 'Vice will use FireShare\'s server default.'
      : 'Publishing will use FireShare\'s server default.';
  }
}

function selectFireShareFolder(kind, value) {
  const picker = fireshareFolderPickers[kind];
  picker.value = String(value || '');
  picker.query = picker.value;
  picker.mode = 'existing';
  picker.touched = true;
  picker.open = false;
  picker.serverDefault = false;
  renderFireShareFolderPicker(kind);
}

function openFireShareFolderList(kind) {
  fireshareFolderPickers[kind].mode = 'existing';
  fireshareFolderPickers[kind].open = true;
  renderFireShareFolderPicker(kind);
}

function filterFireShareFolders(kind) {
  const picker = fireshareFolderPickers[kind];
  const search = document.getElementById(fireShareFolderIds(kind).search);
  picker.query = search?.value || '';
  picker.mode = 'existing';
  picker.open = true;
  renderFireShareFolderPicker(kind);
}

function onFireShareFolderKeydown(event, kind) {
  if (event.key === 'Escape') {
    fireshareFolderPickers[kind].open = false;
    renderFireShareFolderPicker(kind);
    return;
  }
  if (event.key !== 'ArrowDown') return;
  const first = document.getElementById(fireShareFolderIds(kind).list)
    ?.querySelector('[role="option"]');
  if (first) {
    event.preventDefault();
    first.focus();
  }
}

function beginFireShareFolderCreate(kind) {
  const picker = fireshareFolderPickers[kind];
  const ids = fireShareFolderIds(kind);
  picker.mode = 'create';
  picker.touched = true;
  picker.open = false;
  picker.serverDefault = false;
  const newInput = document.getElementById(ids.newName);
  if (newInput) {
    newInput.value = fireShareFolderOptions(kind).includes(picker.value) ? '' : picker.value;
    requestAnimationFrame(() => newInput.focus());
  }
  validateFireShareFolderInput(kind);
  renderFireShareFolderPicker(kind);
}

function validateFireShareFolderInput(kind) {
  const ids = fireShareFolderIds(kind);
  const input = document.getElementById(ids.newName);
  const error = document.getElementById(ids.error);
  const value = input?.value.trim() || '';
  const message = value ? fireShareFolderValidationMessage(value) : '';
  if (error) {
    error.textContent = message;
    error.hidden = !message;
  }
  return !message;
}

function confirmFireShareFolderCreate(kind) {
  const ids = fireShareFolderIds(kind);
  const value = document.getElementById(ids.newName)?.value.trim() || '';
  const message = fireShareFolderValidationMessage(value);
  const error = document.getElementById(ids.error);
  if (error) {
    error.textContent = message;
    error.hidden = !message;
  }
  if (message) return false;
  const picker = fireshareFolderPickers[kind];
  picker.value = value;
  picker.query = value;
  picker.mode = 'existing';
  picker.touched = true;
  picker.open = false;
  picker.serverDefault = false;
  renderFireShareFolderPicker(kind);
  return true;
}

function readFireShareFolder(kind, throwOnError = true) {
  const picker = fireshareFolderPickers[kind];
  if (picker.mode === 'create') {
    const value = document.getElementById(fireShareFolderIds(kind).newName)?.value.trim() || '';
    const message = fireShareFolderValidationMessage(value);
    validateFireShareFolderInput(kind);
    if (message && throwOnError) throw new Error(message);
    return value;
  }
  const message = picker.value ? fireShareFolderValidationMessage(picker.value) : '';
  if (message && throwOnError) throw new Error(message);
  return picker.value;
}

async function loadFireShareFolders(force = false) {
  if (force) fireshareFolderDirectory.generation += 1;
  if (fireshareFolderDirectory.state === 'loading') {
    if (force) fireshareFolderDirectory.reloadPending = true;
    await fireshareFolderDirectory.request;
    if (force || fireshareFolderDirectory.reloadPending) {
      fireshareFolderDirectory.reloadPending = false;
      return loadFireShareFolders(true);
    }
    return;
  }
  if (fireshareFolderDirectory.state === 'ready' && !force) return;
  const requestSource = fireShareConfig().base_url || '';
  const requestGeneration = fireshareFolderDirectory.generation;
  fireshareFolderDirectory.state = 'loading';
  fireshareFolderDirectory.error = '';
  renderFireShareFolderPicker('settings');
  renderFireShareFolderPicker('publish');
  const request = (async () => {
    try {
      const response = await fetch('/api/fireshare/folders', { cache: 'no-store' });
      const data = await fireShareResponseJson(response);
      if (!response.ok || data.ok === false) {
        throw new Error(data.error || 'Could not load FireShare folders');
      }
      const valid = (
        typeof data.default_folder === 'string'
        && FIRE_SHARE_FOLDER_NAME_RE.test(data.default_folder)
        && Array.isArray(data.folders)
        && data.folders.every(folder => typeof folder === 'string' && FIRE_SHARE_FOLDER_NAME_RE.test(folder))
        && new Set(data.folders).size === data.folders.length
      );
      if (!valid) throw new Error('Vice received an invalid folder list');
      if (requestGeneration !== fireshareFolderDirectory.generation) {
        fireshareFolderDirectory.state = 'idle';
        return;
      }
      fireshareFolderDirectory.state = 'ready';
      fireshareFolderDirectory.defaultFolder = data.default_folder;
      fireshareFolderDirectory.folders = [...data.folders];
      fireshareFolderDirectory.source = requestSource;
      const publish = fireshareFolderPickers.publish;
      if (
        fireshareModalSlug
        && !publish.touched
        && !fireShareConfig().default_folder
        && (!publish.value || publish.serverDefault)
      ) {
        publish.value = data.default_folder;
        publish.query = data.default_folder;
        publish.serverDefault = true;
      }
    } catch (err) {
      if (requestGeneration !== fireshareFolderDirectory.generation) {
        fireshareFolderDirectory.state = 'idle';
        return;
      }
      fireshareFolderDirectory.state = 'error';
      fireshareFolderDirectory.defaultFolder = '';
      fireshareFolderDirectory.folders = [];
      fireshareFolderDirectory.error = err?.message || 'Could not load folders';
    } finally {
      renderFireShareFolderPicker('settings');
      renderFireShareFolderPicker('publish');
    }
  })();
  fireshareFolderDirectory.request = request;
  await request;
  fireshareFolderDirectory.request = null;
}

function fireSharePrivacyLabel(value) {
  if (value === true) return 'Private (FireShare login required)';
  if (value === false) return 'Public link';
  return 'FireShare default';
}

// Maps a nullable requested/effective privacy bool to the <select> value
// used by both the settings default and the publish-modal picker.
function fireSharePrivacyChoice(value) {
  if (value === true) return 'private';
  if (value === false) return 'public';
  return 'server_default';
}

// Inverse of fireSharePrivacyChoice: turns a <select> value back into the
// nullable bool the API expects (null = "use FireShare's own default").
function fireSharePrivacyValue(choice) {
  if (choice === 'public') return false;
  if (choice === 'private') return true;
  return null;
}

function fireShareCurrent(clip) {
  return clip?.fireshare?.current || null;
}

function fireShareStateLabel(state) {
  const value = String(state || '').toLowerCase();
  if (value === 'uploading') return 'Uploading';
  if (value === 'processing' || value === 'accepted') return 'Processing';
  if (value === 'ready') return 'Ready';
  if (value === 'failed') return 'Failed';
  if (value === 'stale') return 'Stale';
  if (value === 'canceled') return 'Canceled';
  return 'Not published';
}

function fireShareStateTone(state) {
  const value = String(state || '').toLowerCase();
  if (value === 'ready') return 'ok';
  if (value === 'stale') return 'warn';
  if (value === 'failed') return 'err';
  return 'dim';
}

function openFireShareSettings() {
  nav('settings');
  requestAnimationFrame(() => {
    const rail = document.querySelector('[data-rail="fireshare"]');
    if (rail) rail.click();
  });
}

function renderFireShareSettings() {
  const f = fireShareConfig();
  const base = document.getElementById('s-fireshare-base-url');
  const title = document.getElementById('s-fireshare-title-template');
  const priv = document.getElementById('s-fireshare-default-privacy');
  const https = document.getElementById('s-fireshare-require-https');
  if (base) base.value = f.base_url || '';
  initializeFireShareFolderPicker('settings', f.default_folder || '');
  if (title) title.value = f.default_title_template || '$filename';
  if (priv) priv.value = f.default_privacy || 'server_default';
  if (https) https.checked = f.require_https !== false;
  updateFireShareTokenStatus(Boolean(f.token_configured), false);
  if (f.base_url && f.token_configured) {
    if (fireshareFolderDirectory.source && fireshareFolderDirectory.source !== f.base_url) {
      fireshareFolderDirectory.state = 'idle';
    }
    if (fireshareFolderDirectory.state === 'idle') loadFireShareFolders();
  }
}

function collectFireShareSettings() {
  return {
    base_url: document.getElementById('s-fireshare-base-url')?.value.trim() || '',
    default_privacy: document.getElementById('s-fireshare-default-privacy')?.value || 'server_default',
    default_folder: readFireShareFolder('settings', false),
    default_title_template: document.getElementById('s-fireshare-title-template')?.value.trim() || '$filename',
    require_https: !!document.getElementById('s-fireshare-require-https')?.checked,
  };
}

function updateFireShareTokenStatus(configured, saved) {
  const f = cfg.fireshare || {};
  f.token_configured = !!configured;
  cfg.fireshare = f;
  const status = document.getElementById('s-fireshare-token-status');
  if (!status) return;
  status.textContent = configured ? (saved ? 'Token saved' : 'Token configured') : 'Token not configured';
  status.className = `fireshare-token-status ${configured ? 'ok' : 'warn'}`;
}

async function saveFireShareToken() {
  const input = document.getElementById('s-fireshare-token');
  const value = (input?.value || '').trim();
  try {
    const r = await fetch('/api/fireshare/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: value }),
    });
    const d = await r.json();
    if (!r.ok || d.ok === false) throw new Error(d.error || 'save failed');
    updateFireShareTokenStatus(Boolean(d.token_configured), true);
    if (input) input.value = '';
    loadFireShareFolders(true);
    toast('FireShare token updated', 'ok');
  } catch (err) {
    toast(err?.message || 'Could not save FireShare token', 'err');
  }
}

async function validateFireShareConfig() {
  const statusEl = document.getElementById('s-fireshare-validate-status');
  const body = {
    base_url: document.getElementById('s-fireshare-base-url')?.value.trim() || '',
    token: document.getElementById('s-fireshare-token')?.value.trim() || undefined,
  };
  if (statusEl) statusEl.textContent = 'Validating…';
  try {
    const r = await fetch('/api/fireshare/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (statusEl) {
      statusEl.textContent = d.ok ? 'Connection verified' : (d.error || 'Validation failed');
      statusEl.className = `fireshare-validate-status ${d.ok ? 'ok' : 'warn'}`;
    }
    if (!d.ok) toast(d.error || 'Validation failed', 'err');
    else {
      toast('FireShare connection looks good', 'ok');
      loadFireShareFolders(true);
    }
  } catch (_) {
    if (statusEl) {
      statusEl.textContent = 'Validation failed';
      statusEl.className = 'fireshare-validate-status warn';
    }
    toast('Validation failed', 'err');
  }
}

function renderFireSharePublishModal() {
  if (!fireshareModalSlug) return;
  const clip = clips.find(item => item.slug === fireshareModalSlug);
  if (!clip) return;
  const current = fireShareCurrent(clip);
  const configured = !!(fireShareConfig().base_url && fireShareConfig().token_configured);
  const currentState = String(current?.state || '').toLowerCase();
  const stateLabel = current ? fireShareStateLabel(current.state) : 'Not published';
  setText('fireshare-publish-clip', clip.name || clip.slug);
  setText('fireshare-publish-state', stateLabel);
  const stateEl = document.getElementById('fireshare-publish-state');
  if (stateEl) stateEl.className = `fireshare-state fireshare-state-${fireShareStateTone(current?.state)}`;
  const link = document.getElementById('fireshare-publish-link');
  const linkValue = current?.public_url || clip?.fireshare?.last_ready?.public_url || '';
  if (link) {
    link.value = linkValue;
    link.hidden = !linkValue;
  }
  const err = document.getElementById('fireshare-publish-error');
  if (err) {
    err.textContent = current?.error_message || '';
    err.hidden = !current?.error_message;
  }
  const privacyStatus = document.getElementById('fireshare-publish-privacy-status');
  if (privacyStatus) {
    // Before FireShare has responded, `effective_private` is null/undefined —
    // show the neutral "FireShare default" label rather than guessing.
    privacyStatus.textContent = current
      ? `Privacy: ${fireSharePrivacyLabel(current.effective_private ?? null)}`
      : '';
  }
  const note = document.getElementById('fireshare-publish-note');
  if (note) {
    note.textContent = configured
      ? 'The clip stays in your Vice library.'
      : 'Configure FireShare in Settings before publishing.';
  }
  const publishBtn = document.getElementById('fireshare-publish-start');
  if (publishBtn) {
    publishBtn.disabled = !configured || currentState === 'uploading' || currentState === 'processing';
    publishBtn.textContent = (currentState === 'ready' || currentState === 'stale') ? 'Republish' : 'Publish';
  }
  const retryBtn = document.getElementById('fireshare-publish-retry');
  if (retryBtn) retryBtn.hidden = !current || !['failed', 'retryable_ambiguous', 'canceled'].includes(currentState);
  const cancelBtn = document.getElementById('fireshare-publish-cancel');
  if (cancelBtn) {
    cancelBtn.hidden = currentState !== 'uploading';
    cancelBtn.disabled = fireshareCancelPending;
  }
  const copyBtn = document.getElementById('fireshare-publish-copy');
  if (copyBtn) copyBtn.hidden = !linkValue;
  const openBtn = document.getElementById('fireshare-publish-open');
  if (openBtn) openBtn.hidden = !linkValue;
  updateFireSharePublishProgressBar(current?.progress_pct);
}

// Patches only the modal's progress bar width — used for high-frequency
// progress ticks so they don't force a full modal/clip-list re-render.
function updateFireSharePublishProgressBar(pct) {
  const progress = document.getElementById('fireshare-progress');
  if (progress) progress.style.width = `${Math.max(0, Math.min(100, Number(pct || 0)))}%`;
}

async function refreshFireShareStatus() {
  try {
    const r = await fetch('/api/fireshare/status');
    fireshareStatus = await r.json();
  } catch (_) {
    fireshareStatus = { configured: false, token_configured: false, active: [] };
  }
  updateFireShareTokenStatus(Boolean(fireshareStatus.token_configured || fireShareConfig().token_configured), false);
  if (fireshareModalSlug) renderFireSharePublishModal();
}

function openFireSharePublish(slug) {
  const clip = clips.find(item => item.slug === slug);
  if (!clip) return;
  fireshareModalSlug = slug;
  const f = fireShareConfig();
  const current = fireShareCurrent(clip);
  document.getElementById('fireshare-publish-title').value = clip.name || clip.slug;
  const initialFolder = current?.folder || f.default_folder || (
    fireshareFolderDirectory.state === 'ready'
      ? fireshareFolderDirectory.defaultFolder
      : ''
  );
  const usesServerDefault = !current?.folder && !f.default_folder && !!initialFolder;
  initializeFireShareFolderPicker('publish', initialFolder, usesServerDefault);
  const privacySelect = document.getElementById('fireshare-publish-privacy');
  if (privacySelect) {
    // Republish prefills the *prior requested* privacy for this clip only
    // when it was an explicit public/private choice; a prior server-default
    // (and a brand-new clip with no history at all) prefill the global
    // default setting, which itself may be server-default.
    privacySelect.value = current
      ? fireSharePrivacyChoice(current.requested_private ?? null)
      : (f.default_privacy || 'server_default');
  }
  document.getElementById('fireshare-publish-modal').classList.add('open');
  renderFireSharePublishModal();
  refreshFireShareStatus();
  if (f.base_url && f.token_configured) loadFireShareFolders();
}

function closeFireSharePublish() {
  document.getElementById('fireshare-publish-modal').classList.remove('open');
  fireshareModalSlug = null;
}

function onFireSharePublishBackdrop(ev) {
  if (ev.target?.id === 'fireshare-publish-modal') closeFireSharePublish();
}

async function startFireSharePublish() {
  if (!fireshareModalSlug) return;
  try {
    const privacyChoice = document.getElementById('fireshare-publish-privacy')?.value || 'server_default';
    const body = {
      title: document.getElementById('fireshare-publish-title')?.value.trim() || '',
      folder: readFireShareFolder('publish'),
      // Explicit null tells the backend "use FireShare's own default"; it must
      // never be coerced to a guessed true/false anywhere in this pipeline.
      private: fireSharePrivacyValue(privacyChoice),
    };
    const r = await fetch(`/api/clips/${encodeURIComponent(fireshareModalSlug)}/fireshare/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok || d.ok === false) throw new Error(d.error || 'publish failed');
    applyFireShareAttempt(fireshareModalSlug, d.attempt);
    renderFireSharePublishModal();
    toast('FireShare publish started', 'ok');
  } catch (err) {
    if (String(err?.message || '').toLowerCase().includes('not configured')) {
      openFireShareSettings();
    }
    toast(err?.message || 'Could not start publish', 'err');
  }
}

async function retryFireSharePublish() {
  const clip = clips.find(item => item.slug === fireshareModalSlug);
  const attemptId = clip?.fireshare?.current?.attempt_id;
  if (!attemptId) return;
  try {
    const r = await fetch(`/api/fireshare/attempts/${encodeURIComponent(attemptId)}/retry`, { method: 'POST' });
    const d = await r.json();
    if (!r.ok || d.ok === false) throw new Error(d.error || 'retry failed');
    applyFireShareAttempt(fireshareModalSlug, d.attempt);
    renderFireSharePublishModal();
    toast('Retry started', 'ok');
  } catch (err) {
    toast(err?.message || 'Retry failed', 'err');
  }
}

async function cancelFireSharePublish() {
  const clip = clips.find(item => item.slug === fireshareModalSlug);
  const attemptId = clip?.fireshare?.current?.attempt_id;
  if (!attemptId || fireshareCancelPending) return;
  const slug = fireshareModalSlug;
  fireshareCancelPending = true;
  renderFireSharePublishModal();
  try {
    const r = await fetch(`/api/fireshare/attempts/${encodeURIComponent(attemptId)}/cancel`, { method: 'POST' });
    const d = await safeJsonResponse(r);
    if (!r.ok || d.ok === false) throw new Error(d.error || `Cancel failed (HTTP ${r.status})`);
    if (d.attempt) applyFireShareAttempt(slug, d.attempt);
    // `cancelled: false` means the upload raced to a terminal state (ready/
    // failed) on its own just before this request landed — not an error,
    // just too late to cancel. Either way the authoritative attempt state
    // above is already applied, so the modal/badge close or update at once.
    toast(
      d.cancelled === false ? 'Upload already finished before it could be canceled' : 'Publish canceled',
      d.cancelled === false ? 'warn' : 'ok'
    );
  } catch (err) {
    toast(err?.message || 'Cancel failed', 'err');
  } finally {
    fireshareCancelPending = false;
    renderFireSharePublishModal();
  }
}

function copyFireShareLink() {
  const input = document.getElementById('fireshare-publish-link');
  const url = input?.value || '';
  if (!url) return;
  copyToClipboard(url).then(ok => {
    if (ok) toast('FireShare link copied', 'ok');
    else showManualCopyModal(url);
  });
}

function openFireShareLink() {
  const url = document.getElementById('fireshare-publish-link')?.value || '';
  if (!url) return;
  openExternal(url);
}

function applyFireShareAttempt(slug, attempt) {
  const clip = clips.find(item => item.slug === slug);
  if (!clip || !attempt) return;
  clip.fireshare = clip.fireshare || {};
  const prev = clip.fireshare.current;
  const merged = { ...(prev || {}), ...attempt };
  // A freshly (re)started attempt gets a brand-new attempt_id with its own
  // independent sequence space server-side; a leftover __seq from the
  // attempt it superseded must not leak forward and wrongly reject that
  // new attempt's own (low-numbered) events as "stale".
  if (attempt.attempt_id && prev && prev.attempt_id && attempt.attempt_id !== prev.attempt_id) {
    merged.__seq = attempt.__seq ?? null;
  }
  clip.fireshare.current = merged;
  if (String(attempt.state || '').toLowerCase() === 'ready') {
    clip.fireshare.last_ready = { ...attempt };
  }
}

function onFireShareEvent(msg) {
  const slug = msg.slug;
  if (!slug) return;
  const clip = clips.find(item => item.slug === slug);
  if (!clip) return;
  const current = fireShareCurrent(clip);
  // An event for a different attempt than the one currently tracked for
  // this clip is almost always a stale broadcast from an attempt a
  // retry/republish has already superseded — never let it affect display.
  if (current && msg.attempt_id && current.attempt_id && msg.attempt_id !== current.attempt_id) {
    return;
  }
  // Reject an out-of-order/late tick for the *same* attempt (e.g. a
  // throttled progress broadcast still in flight when a terminal state
  // arrived, only now being delivered) so it can never regress an
  // already-applied newer state back to (say) "uploading".
  if (current && msg.seq != null && current.__seq != null && msg.seq <= current.__seq) {
    return;
  }
  const stateByType = {
    fireshare_publish_started: 'uploading',
    fireshare_publish_progress: 'uploading',
    fireshare_publish_processing: 'processing',
    fireshare_publish_ready: 'ready',
    fireshare_publish_failed: 'failed',
    fireshare_publish_stale: 'stale',
  };
  const state = msg.state || stateByType[msg.type];
  if (!state) return;
  const remoteError = msg.error && typeof msg.error === 'object' ? msg.error : {};
  const patch = {
    attempt_id: msg.attempt_id,
    state,
    public_url: msg.public_url || '',
    error_code: msg.error_code || remoteError.code || '',
    error_message: msg.error_message || remoteError.message || '',
  };
  if (msg.progress_pct != null || msg.progress != null) {
    patch.progress_pct = Number(msg.progress_pct ?? (msg.progress * 100));
  }
  if (msg.requested_private !== undefined) patch.requested_private = msg.requested_private;
  if (msg.effective_private !== undefined) patch.effective_private = msg.effective_private;
  if (msg.seq != null) patch.__seq = msg.seq;
  applyFireShareAttempt(slug, patch);
  // High-frequency progress ticks patch the progress bar in place. State
  // transitions rerender only the authoritative publish surface; clip cards
  // intentionally have no FireShare status dependency.
  const isProgressOnly = msg.type === 'fireshare_publish_progress';
  if (fireshareModalSlug === slug) {
    if (isProgressOnly) {
      updateFireSharePublishProgressBar(patch.progress_pct);
    } else {
      renderFireSharePublishModal();
    }
  }
}
