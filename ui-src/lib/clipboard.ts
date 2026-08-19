import {IS_NATIVE} from './env';

interface ClipboardBridge {
  api?: {copy_to_clipboard?: (text: string) => Promise<boolean>};
}

/**
 * Copy text, preferring the native bridge.
 *
 * The window is not always a secure context and QtWebEngine's clipboard
 * permissions vary by build, so every path can fail. The caller is expected to
 * offer the text for manual copying when this returns false rather than
 * pretending it worked.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false;

  const bridge = (window as unknown as {pywebview?: ClipboardBridge}).pywebview;
  if (IS_NATIVE && bridge?.api?.copy_to_clipboard) {
    try {
      return Boolean(await bridge.api.copy_to_clipboard(String(text)));
    } catch (err) {
      console.warn('Native clipboard bridge failed, falling back', err);
    }
  }

  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) {
    console.warn('Clipboard API failed, falling back', err);
  }

  // execCommand is deprecated but still the only thing that works in an
  // insecure context, which the local UI often is.
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch (err) {
    console.warn('Clipboard fallback failed', err);
    return false;
  }
}
