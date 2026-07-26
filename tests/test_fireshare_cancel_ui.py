"""Behavior tests for the FireShare Cancel-upload UI (vice/ui/scripts/fireshare.js).

Runs the real client-side JS in Node's `vm` module (no jsdom/build step
needed) so `cancelFireSharePublish()` executes exactly as it does in the
browser, with only `fetch`/`document`/`toast`/`clips`/`cfg`/`renderClips`
stubbed out. This proves:

  * a non-JSON server response (the exact failure mode of the reported bug —
    aiohttp's default plaintext 404) produces a clean, useful toast message
    instead of a raw "Unexpected token" SyntaxError, and
  * the Cancel button guards against duplicate clicks while a request is in
    flight, and the guard clears afterwards regardless of outcome, and
  * a successful cancel or a "raced to completion" response both apply the
    returned attempt state immediately, with the correct success/error tone.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
FIRESHARE_JS = REPO_ROOT / "vice" / "ui" / "scripts" / "fireshare.js"

NODE_HARNESS = r"""
'use strict';
const vm = require('vm');
const fs = require('fs');
const assert = require('assert');

const src = fs.readFileSync(process.argv[2], 'utf8');

function makeSandbox() {
  const toasts = [];
  const renderClipsCalls = [];
  const sandbox = {
    console,
    cfg: { fireshare: {} },
    clips: [],
    toast: (msg, type) => toasts.push({ msg, type }),
    renderClips: () => renderClipsCalls.push(true),
    setText: () => {},
    document: { getElementById: () => null },
    __toasts: toasts,
    __renderClipsCalls: renderClipsCalls,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'fireshare.js' });
  // `fireshareModalSlug`/`fireshareCancelPending` are module-level `let`
  // bindings: vm keeps those in the context's lexical scope, not as
  // properties on the sandbox object, so `sandbox.fireshareModalSlug = x`
  // from host code would silently no-op. Function declarations *do* become
  // sandbox properties, so define tiny accessors (in the same context, thus
  // sharing the same lexical scope) to read/write them from the test.
  vm.runInContext(
    'function __setModalSlug(v) { fireshareModalSlug = v; }\n' +
    'function __getCancelPending() { return fireshareCancelPending; }\n',
    sandbox,
    { filename: 'test-shims.js' }
  );
  return sandbox;
}

function makeResponse({ ok, status, payload, text, contentType = 'application/json' }) {
  return {
    ok,
    status,
    statusText: '',
    headers: { get: () => contentType },
    text: async () => text !== undefined ? text : JSON.stringify(payload),
  };
}

async function testNonJsonResponseProducesUsefulMessage() {
  const sandbox = makeSandbox();
  sandbox.clips = [{ slug: 's1', fireshare: { current: { attempt_id: 'a1', state: 'uploading' } } }];
  sandbox.__setModalSlug('s1');
  sandbox.fetch = async () => makeResponse({
    ok: false,
    status: 502,
    text: '<html>bad gateway</html>',
    contentType: 'text/html',
  });

  await sandbox.cancelFireSharePublish();

  assert.strictEqual(sandbox.__toasts.length, 1, 'expected exactly one toast');
  const t = sandbox.__toasts[0];
  assert.strictEqual(t.type, 'err');
  assert.ok(!/unexpected token/i.test(t.msg), `message leaked the raw JSON parse error: ${t.msg}`);
  assert.ok(/502/.test(t.msg), `message should reference the HTTP status: ${t.msg}`);
  assert.strictEqual(sandbox.__getCancelPending(), false, 'pending guard must be released after failure');
}

async function testSuccessfulCancelAppliesAttemptAndTogglesPending() {
  const sandbox = makeSandbox();
  sandbox.clips = [{ slug: 's1', fireshare: { current: { attempt_id: 'a1', state: 'uploading' } } }];
  sandbox.__setModalSlug('s1');
  let pendingDuringRequest = null;
  sandbox.fetch = async () => {
    pendingDuringRequest = sandbox.__getCancelPending();
    return makeResponse({
      ok: true,
      status: 200,
      payload: { ok: true, attempt: { attempt_id: 'a1', state: 'canceled' } },
    });
  };

  await sandbox.cancelFireSharePublish();

  assert.strictEqual(pendingDuringRequest, true, 'the button must be disabled while the request is in flight');
  assert.strictEqual(sandbox.__getCancelPending(), false, 'pending guard must clear after success');
  assert.strictEqual(sandbox.clips[0].fireshare.current.state, 'canceled', 'attempt state must apply immediately');
  assert.strictEqual(sandbox.__toasts[0].type, 'ok');
  assert.ok(sandbox.__renderClipsCalls.length >= 1, 'clip list must refresh so any badge updates');
}

async function testDuplicateClickIsIgnoredWhileRequestInFlight() {
  const sandbox = makeSandbox();
  sandbox.clips = [{ slug: 's1', fireshare: { current: { attempt_id: 'a1', state: 'uploading' } } }];
  sandbox.__setModalSlug('s1');
  let fetchCalls = 0;
  let resolveFetch;
  sandbox.fetch = () => {
    fetchCalls += 1;
    return new Promise((resolve) => { resolveFetch = resolve; });
  };

  const firstCall = sandbox.cancelFireSharePublish();
  const secondCall = sandbox.cancelFireSharePublish(); // arrives while the first is still pending
  await secondCall;

  assert.strictEqual(fetchCalls, 1, 'a second click must not issue a second network request');

  resolveFetch(makeResponse({
    ok: true,
    status: 200,
    payload: { ok: true, attempt: { attempt_id: 'a1', state: 'canceled' } },
  }));
  await firstCall;
  assert.strictEqual(sandbox.__getCancelPending(), false);
}

async function testRaceAlreadyFinishedAppliesStateAndSurfacesError() {
  const sandbox = makeSandbox();
  sandbox.clips = [{ slug: 's1', fireshare: { current: { attempt_id: 'a1', state: 'uploading' } } }];
  sandbox.__setModalSlug('s1');
  sandbox.fetch = async () => makeResponse({
    ok: false,
    status: 409,
    payload: {
      ok: false,
      error: 'This FireShare upload can no longer be canceled because it is ready.',
      error_code: 'attempt_not_cancelable',
      state: 'ready',
      cancelable: false,
    },
  });

  await sandbox.cancelFireSharePublish();

  assert.strictEqual(sandbox.clips[0].fireshare.current.state, 'ready');
  assert.strictEqual(sandbox.__toasts[0].type, 'err');
  assert.ok(/ready/.test(sandbox.__toasts[0].msg));
}

async function testNotFoundJsonErrorEnvelopeSurfacesServerMessage() {
  const sandbox = makeSandbox();
  sandbox.clips = [{ slug: 's1', fireshare: { current: { attempt_id: 'a1', state: 'uploading' } } }];
  sandbox.__setModalSlug('s1');
  sandbox.fetch = async () => makeResponse({
    ok: false,
    status: 404,
    payload: { ok: false, error: 'Publish attempt not found', error_code: 'not_found' },
  });

  await sandbox.cancelFireSharePublish();

  assert.strictEqual(sandbox.__toasts[0].type, 'err');
  assert.strictEqual(sandbox.__toasts[0].msg, 'Publish attempt not found');
}

async function testFinalProgressHidesCancelWithoutFullRender() {
  const sandbox = makeSandbox();
  const cancelButton = { hidden: false, disabled: false };
  const progress = { style: {} };
  sandbox.document.getElementById = (id) => {
    if (id === 'fireshare-publish-cancel') return cancelButton;
    if (id === 'fireshare-progress') return progress;
    return null;
  };
  sandbox.clips = [{
    slug: 's1',
    fireshare: {
      current: { attempt_id: 'a1', state: 'uploading', cancelable: true, __seq: 1 },
    },
  }];
  sandbox.__setModalSlug('s1');

  sandbox.onFireShareEvent({
    type: 'fireshare_publish_progress',
    slug: 's1',
    attempt_id: 'a1',
    seq: 2,
    progress_pct: 100,
    cancelable: false,
  });

  assert.strictEqual(cancelButton.hidden, true, 'final multipart progress must hide Cancel');
  assert.strictEqual(progress.style.width, '100%');
}

async function testOlderCancelConflictCannotRegressNewerReadyEvent() {
  const sandbox = makeSandbox();
  sandbox.clips = [{
    slug: 's1',
    fireshare: {
      current: { attempt_id: 'a1', state: 'uploading', cancelable: true, __seq: 2 },
    },
  }];
  sandbox.__setModalSlug('s1');
  sandbox.fetch = async () => {
    sandbox.onFireShareEvent({
      type: 'fireshare_publish_ready',
      slug: 's1',
      attempt_id: 'a1',
      seq: 5,
      state: 'ready',
    });
    return makeResponse({
      ok: false,
      status: 409,
      payload: {
        ok: false,
        error: 'Upload is no longer active.',
        error_code: 'attempt_not_active',
        state: 'uploading',
        cancelable: false,
        seq: 4,
      },
    });
  };

  await sandbox.cancelFireSharePublish();

  assert.strictEqual(sandbox.clips[0].fireshare.current.state, 'ready');
  assert.strictEqual(sandbox.clips[0].fireshare.current.__seq, 5);
}

(async () => {
  await testNonJsonResponseProducesUsefulMessage();
  await testSuccessfulCancelAppliesAttemptAndTogglesPending();
  await testDuplicateClickIsIgnoredWhileRequestInFlight();
  await testRaceAlreadyFinishedAppliesStateAndSurfacesError();
  await testNotFoundJsonErrorEnvelopeSurfacesServerMessage();
  await testFinalProgressHidesCancelWithoutFullRender();
  await testOlderCancelConflictCannotRegressNewerReadyEvent();
  console.log('ALL_JS_TESTS_OK');
})().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
"""


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class FireShareCancelUiBehaviorTests(unittest.TestCase):
    def test_cancel_button_behavior_via_node(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            harness_path = Path(tmp) / "fireshare_cancel_harness.js"
            harness_path.write_text(NODE_HARNESS, encoding="utf-8")
            result = subprocess.run(
                ["node", str(harness_path), str(FIRESHARE_JS)],
                capture_output=True,
                text=True,
                timeout=30,
            )
        self.assertEqual(
            result.returncode, 0,
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}",
        )
        self.assertIn("ALL_JS_TESTS_OK", result.stdout)

    def test_node_check_syntax(self) -> None:
        result = subprocess.run(
            ["node", "--check", str(FIRESHARE_JS)],
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
