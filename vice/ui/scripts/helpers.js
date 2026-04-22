'use strict';
// helpers.js — toast, fmt helpers, escape, copy uninstall cmd

// ═══════════════════════════════════════════════════════════════════
// Toasts / helpers
// ═══════════════════════════════════════════════════════════════════
function toast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${svgEl(type === 'ok' ? 'checkCircle2' : 'alertCircle', 14)} ${escHtml(msg)}`;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}
function fmtSec(s, short = false) {
  if (s < 60) return short ? `${s.toFixed(s % 1 ? 1 : 0)}s` : `${s} s`;
  const m = Math.floor(s/60), r = s % 60;
  if (short) return `${m}:${String(Math.floor(r)).padStart(2,'0')}`;
  return r === 0 ? `${m} min` : `${m}:${String(r).padStart(2,'0')} min`;
}
function toTC(s) {
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), se = s%60;
  const ms = String(Math.round((se%1)*1000)).padStart(3,'0');
  return `${pad(h)}:${pad(m)}:${pad(Math.floor(se))}.${ms}`;
}
function pad(n) { return String(n).padStart(2,'0'); }
function escAttr(s) { return String(s).replace(/&/g,'&amp;').replace(/'/g,'&#39;').replace(/"/g,'&quot;'); }
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }

// Forward a debug message to both the browser console and (in native mode)
// the Python log, so vice-app --debug captures JS events in one timeline.
function nativeLog(msg) {
  try { console.log('[vice]', msg); } catch (_) {}
  try {
    if (IS_NATIVE && window.pywebview && window.pywebview.api && window.pywebview.api.log_debug) {
      window.pywebview.api.log_debug(String(msg));
    }
  } catch (_) {}
}

// Copy `text` to the clipboard. Resolves to true on success, false on failure.
// In the native (QtWebEngine) window we go through the pywebview bridge into
// wl-copy/xclip/xsel — the in-page Clipboard API has crashed the render
// process on http:// origins. In browser mode we try the async API first
// and fall back to execCommand. Every branch is logged via nativeLog.
async function copyToClipboard(text) {
  const len = (text || '').length;
  const bridge = !!(IS_NATIVE && window.pywebview && window.pywebview.api && window.pywebview.api.copy_to_clipboard);
  nativeLog(`copyToClipboard: len=${len} IS_NATIVE=${IS_NATIVE} bridge=${bridge}`);
  if (!text) return false;
  if (bridge) {
    try {
      const ok = await window.pywebview.api.copy_to_clipboard(String(text));
      nativeLog(`copyToClipboard: bridge returned ${ok}`);
      return !!ok;
    } catch (err) {
      nativeLog(`copyToClipboard: bridge threw ${err && err.message ? err.message : err}`);
    }
  }
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      nativeLog('copyToClipboard: async API ok');
      return true;
    }
  } catch (err) {
    nativeLog(`copyToClipboard: async API threw ${err && err.message ? err.message : err}`);
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    ta.remove();
    nativeLog(`copyToClipboard: execCommand ok=${ok}`);
    return ok;
  } catch (err) {
    nativeLog(`copyToClipboard: execCommand threw ${err && err.message ? err.message : err}`);
    return false;
  }
}

// Global renderer-error listeners so a page-level crash leaves a breadcrumb.
window.addEventListener('error', ev => {
  nativeLog(`window.error: ${ev.message} at ${ev.filename}:${ev.lineno}:${ev.colno}`);
});
window.addEventListener('unhandledrejection', ev => {
  const r = ev.reason;
  nativeLog(`unhandledrejection: ${r && r.message ? r.message : r}`);
});

function copyUninstallCmd() {
  copyToClipboard('vice uninstall').then(ok =>
    toast(ok ? 'Command copied — paste it into a terminal' : 'Could not copy', ok ? 'ok' : 'err'));
}
