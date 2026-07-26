'use strict';
// fireshare.js — FireShare settings + explicit clip publish modal

let fireshareStatus = { configured: false, token_configured: false, active: [] };
let fireshareModalSlug = null;
// Guards the Cancel-upload button against duplicate clicks while a cancel
// request is in flight; cleared in the `finally` below regardless of outcome.
let fireshareCancelPending = false;

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

function fireshareClipBadgeHtml(clip) {
  const cur = fireShareCurrent(clip);
  if (!cur) return '';
  const label = fireShareStateLabel(cur.state);
  const tone = fireShareStateTone(cur.state);
  return `<div class="clip-fireshare clip-fireshare-${tone}">${escHtml(label)}</div>`;
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
  const folder = document.getElementById('s-fireshare-default-folder');
  const title = document.getElementById('s-fireshare-title-template');
  const priv = document.getElementById('s-fireshare-default-privacy');
  const https = document.getElementById('s-fireshare-require-https');
  if (base) base.value = f.base_url || '';
  if (folder) folder.value = f.default_folder || '';
  if (title) title.value = f.default_title_template || '$filename';
  if (priv) priv.value = f.default_privacy || 'server_default';
  if (https) https.checked = f.require_https !== false;
  updateFireShareTokenStatus(Boolean(f.token_configured), false);
}

function collectFireShareSettings() {
  return {
    base_url: document.getElementById('s-fireshare-base-url')?.value.trim() || '',
    default_privacy: document.getElementById('s-fireshare-default-privacy')?.value || 'server_default',
    default_folder: document.getElementById('s-fireshare-default-folder')?.value.trim() || '',
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
    const d = await fireShareResponseJson(r);
    if (!r.ok || d.ok === false) throw new Error(d.error || 'save failed');
    updateFireShareTokenStatus(Boolean(d.token_configured), true);
    if (input) input.value = '';
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
    const d = await fireShareResponseJson(r);
    if (statusEl) {
      statusEl.textContent = d.ok ? 'Connection verified' : (d.error || 'Validation failed');
      statusEl.className = `fireshare-validate-status ${d.ok ? 'ok' : 'warn'}`;
    }
    if (!d.ok) toast(d.error || 'Validation failed', 'err');
    else toast('FireShare connection looks good', 'ok');
  } catch (err) {
    const message = err?.message || 'Validation failed';
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.className = 'fireshare-validate-status warn';
    }
    toast(message, 'err');
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
  updateFireShareCancelButton(current);
  const copyBtn = document.getElementById('fireshare-publish-copy');
  if (copyBtn) copyBtn.hidden = !linkValue;
  const openBtn = document.getElementById('fireshare-publish-open');
  if (openBtn) openBtn.hidden = !linkValue;
  updateFireSharePublishProgressBar(current?.progress_pct);
}

function updateFireShareCancelButton(current) {
  const cancelBtn = document.getElementById('fireshare-publish-cancel');
  if (cancelBtn) {
    const state = String(current?.state || '').toLowerCase();
    cancelBtn.hidden = state !== 'uploading' || current?.cancelable === false;
    cancelBtn.disabled = fireshareCancelPending;
  }
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
    fireshareStatus = await fireShareResponseJson(r);
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
  document.getElementById('fireshare-publish-folder').value = f.default_folder || '';
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
  const privacyChoice = document.getElementById('fireshare-publish-privacy')?.value || 'server_default';
  const body = {
    title: document.getElementById('fireshare-publish-title')?.value.trim() || '',
    folder: document.getElementById('fireshare-publish-folder')?.value.trim() || '',
    // Explicit null tells the backend "use FireShare's own default"; it must
    // never be coerced to a guessed true/false anywhere in this pipeline.
    private: fireSharePrivacyValue(privacyChoice),
  };
  try {
    const r = await fetch(`/api/clips/${encodeURIComponent(fireshareModalSlug)}/fireshare/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await fireShareResponseJson(r);
    if (!r.ok || d.ok === false) throw new Error(d.error || 'publish failed');
    applyFireShareAttempt(fireshareModalSlug, d.attempt);
    renderFireSharePublishModal();
    renderClips();
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
    const d = await fireShareResponseJson(r);
    if (!r.ok || d.ok === false) throw new Error(d.error || 'retry failed');
    applyFireShareAttempt(fireshareModalSlug, d.attempt);
    renderFireSharePublishModal();
    renderClips();
    toast('Retry started', 'ok');
  } catch (err) {
    toast(err?.message || 'Retry failed', 'err');
  }
}

async function cancelFireSharePublish() {
  const slug = fireshareModalSlug;
  const clip = clips.find(item => item.slug === slug);
  const attemptId = clip?.fireshare?.current?.attempt_id;
  if (!attemptId || fireshareCancelPending) return;
  fireshareCancelPending = true;
  renderFireSharePublishModal();
  try {
    const r = await fetch(`/api/fireshare/attempts/${encodeURIComponent(attemptId)}/cancel`, { method: 'POST' });
    const d = await fireShareResponseJson(r);
    if (!r.ok || d.ok === false) {
      const current = fireShareCurrent(clip);
      const responseIsCurrent = (
        d.seq == null
        || current?.__seq == null
        || Number(d.seq) >= Number(current.__seq)
      );
      if (
        d.state
        && String(current?.state || '').toLowerCase() === 'uploading'
        && responseIsCurrent
      ) {
        applyFireShareAttempt(slug, {
          attempt_id: attemptId,
          state: d.state,
          cancelable: d.cancelable,
          __seq: d.seq,
        });
      } else if (d.cancelable !== undefined && current?.attempt_id === attemptId) {
        applyFireShareAttempt(slug, {
          attempt_id: attemptId,
          cancelable: d.cancelable,
        });
      }
      if (fireshareModalSlug === slug) renderFireSharePublishModal();
      renderClips();
      throw new Error(d.error || 'cancel failed');
    }
    applyFireShareAttempt(slug, d.attempt);
    if (fireshareModalSlug === slug) renderFireSharePublishModal();
    renderClips();
    toast('Publish canceled', 'ok');
  } catch (err) {
    toast(err?.message || 'Cancel failed', 'err');
  } finally {
    fireshareCancelPending = false;
    renderFireSharePublishModal();
    renderClips();
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
  if (
    msg.type === 'fireshare_publish_progress'
    && String(current?.state || '').toLowerCase() !== 'uploading'
  ) {
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
  if (msg.cancelable !== undefined) patch.cancelable = msg.cancelable;
  if (msg.requested_private !== undefined) patch.requested_private = msg.requested_private;
  if (msg.effective_private !== undefined) patch.effective_private = msg.effective_private;
  if (msg.seq != null) patch.__seq = msg.seq;
  applyFireShareAttempt(slug, patch);
  // High-frequency progress ticks patch the progress bar in place; only a
  // genuine state transition (started/processing/ready/failed/stale)
  // rerenders the modal in full and the clip list at all.
  const isProgressOnly = msg.type === 'fireshare_publish_progress';
  if (fireshareModalSlug === slug) {
    if (isProgressOnly) {
      updateFireSharePublishProgressBar(patch.progress_pct);
      updateFireShareCancelButton(fireShareCurrent(clip));
    } else {
      renderFireSharePublishModal();
    }
  }
  if (!isProgressOnly) renderClips();
}
