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
    returned attempt state immediately, with the correct ok/warn tone.
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

async function testNonJsonResponseProducesUsefulMessage() {
  const sandbox = makeSandbox();
  sandbox.clips = [{ slug: 's1', fireshare: { current: { attempt_id: 'a1', state: 'uploading' } } }];
  sandbox.__setModalSlug('s1');
  sandbox.fetch = async () => ({
    ok: false,
    status: 502,
    json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0'); },
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
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, cancelled: true, attempt: { attempt_id: 'a1', state: 'canceled' } }),
    };
  };

  await sandbox.cancelFireSharePublish();

  assert.strictEqual(pendingDuringRequest, true, 'the button must be disabled while the request is in flight');
  assert.strictEqual(sandbox.__getCancelPending(), false, 'pending guard must clear after success');
  assert.strictEqual(sandbox.clips[0].fireshare.current.state, 'canceled', 'attempt state must apply immediately');
  assert.strictEqual(sandbox.__toasts[0].type, 'ok');
  assert.strictEqual(sandbox.__renderClipsCalls.length, 0, 'clip cards must not depend on FireShare state');
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

  resolveFetch({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, cancelled: true, attempt: { attempt_id: 'a1', state: 'canceled' } }),
  });
  await firstCall;
  assert.strictEqual(sandbox.__getCancelPending(), false);
}

async function testRaceAlreadyFinishedSurfacesWarnNotError() {
  const sandbox = makeSandbox();
  sandbox.clips = [{ slug: 's1', fireshare: { current: { attempt_id: 'a1', state: 'uploading' } } }];
  sandbox.__setModalSlug('s1');
  sandbox.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      cancelled: false,
      attempt: { attempt_id: 'a1', state: 'ready', public_url: 'https://fireshare.example.com/v/1' },
    }),
  });

  await sandbox.cancelFireSharePublish();

  assert.strictEqual(sandbox.clips[0].fireshare.current.state, 'ready');
  assert.strictEqual(sandbox.__toasts[0].type, 'warn');
}

async function testRaceThenRealReadyBroadcastIsNotDroppedAndKeepsPublicUrl() {
  // Regression test for the 02814e2 race bug: a cancel() call that loses the
  // race to a completed upload must not poison the seq space so that the
  // *real* ready broadcast (which carries the public_url) gets silently
  // dropped as "stale" by onFireShareEvent's out-of-order guard, leaving
  // Copy/Open link blank forever.
  const sandbox = makeSandbox();
  sandbox.clips = [{
    slug: 's1',
    fireshare: { current: { attempt_id: 'a1', state: 'uploading', __seq: 5 } },
  }];
  sandbox.__setModalSlug('s1');
  sandbox.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      cancelled: false,
      // The fixed manager contract: no __seq/seq field on the raced attempt
      // payload, so applying it can never collide with the real broadcast's
      // sequence number.
      attempt: { attempt_id: 'a1', state: 'ready', public_url: 'https://fireshare.example.com/v/1' },
    }),
  });

  await sandbox.cancelFireSharePublish();

  assert.strictEqual(sandbox.__toasts[0].type, 'warn', 'raced-to-completion must warn, not error');
  assert.strictEqual(sandbox.clips[0].fireshare.current.state, 'ready');
  // The prior __seq must survive untouched (the raced patch carries none).
  assert.strictEqual(sandbox.clips[0].fireshare.current.__seq, 5);

  // Now the authoritative "ready" WS broadcast arrives with a fresh,
  // higher seq -- it must NOT be dropped as stale, and must deliver the
  // real public_url.
  sandbox.onFireShareEvent({
    slug: 's1',
    type: 'fireshare_publish_ready',
    attempt_id: 'a1',
    state: 'ready',
    public_url: 'https://fireshare.example.com/v/1',
    seq: 6,
  });

  assert.strictEqual(sandbox.clips[0].fireshare.current.public_url, 'https://fireshare.example.com/v/1',
    'the real ready broadcast must not be dropped as stale');
  assert.strictEqual(sandbox.clips[0].fireshare.current.__seq, 6);
  assert.strictEqual(sandbox.clips[0].fireshare.last_ready.public_url, 'https://fireshare.example.com/v/1');
  // No additional error toast should have been raised for this broadcast.
  assert.ok(!sandbox.__toasts.some(t => t.type === 'err'), 'no error toast expected for a successful race');
}

async function testNotFoundJsonErrorEnvelopeSurfacesServerMessage() {
  const sandbox = makeSandbox();
  sandbox.clips = [{ slug: 's1', fireshare: { current: { attempt_id: 'a1', state: 'uploading' } } }];
  sandbox.__setModalSlug('s1');
  sandbox.fetch = async () => ({
    ok: false,
    status: 404,
    json: async () => ({ ok: false, error: 'Publish attempt not found', error_code: 'not_found' }),
  });

  await sandbox.cancelFireSharePublish();

  assert.strictEqual(sandbox.__toasts[0].type, 'err');
  assert.strictEqual(sandbox.__toasts[0].msg, 'Publish attempt not found');
}

(async () => {
  await testNonJsonResponseProducesUsefulMessage();
  await testSuccessfulCancelAppliesAttemptAndTogglesPending();
  await testDuplicateClickIsIgnoredWhileRequestInFlight();
  await testRaceAlreadyFinishedSurfacesWarnNotError();
  await testRaceThenRealReadyBroadcastIsNotDroppedAndKeepsPublicUrl();
  await testNotFoundJsonErrorEnvelopeSurfacesServerMessage();
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
