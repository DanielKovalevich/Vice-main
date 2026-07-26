"""Behavior tests for the FireShare upload-progress UI patch-in-place fix
(vice/ui/scripts/fireshare.js).

User symptom: FireShare already shows the video as ready while Vice's own
progress bar keeps climbing. On the UI side this was caused by
``onFireShareEvent`` calling a full ``renderClips()`` for high-frequency
progress ticks, and applying any progress patch unconditionally —
including a stale/late one for an attempt that had already reached a
terminal state, or one that belonged to an attempt a retry/republish had
already superseded — which could regress the displayed state back to
"uploading".

Runs the real client-side JS in Node's `vm` module (matching the pattern in
`tests/test_fireshare_cancel_ui.py`) so `onFireShareEvent()` executes exactly
as it does in the browser.
"""

from __future__ import annotations

import shutil
import subprocess
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
  const renderClipsCalls = [];
  const progressBarWidths = [];
  const elements = {
    'fireshare-progress': { style: {} },
    'fireshare-publish-state': { className: '' },
    'fireshare-publish-link': {},
    'fireshare-publish-error': {},
    'fireshare-publish-privacy-status': {},
    'fireshare-publish-note': {},
    'fireshare-publish-start': {},
    'fireshare-publish-retry': {},
    'fireshare-publish-cancel': {},
    'fireshare-publish-copy': {},
    'fireshare-publish-open': {},
  };
  const sandbox = {
    console,
    cfg: { fireshare: { base_url: 'https://fireshare.example.com', token_configured: true } },
    clips: [],
    toast: () => {},
    renderClips: () => renderClipsCalls.push(true),
    setText: () => {},
    document: {
      getElementById: (id) => {
        if (!(id in elements)) return null;
        return elements[id];
      },
    },
    __renderClipsCalls: renderClipsCalls,
    __progressBarWidth: () => elements['fireshare-progress'].style.width,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'fireshare.js' });
  vm.runInContext(
    'function __setModalSlug(v) { fireshareModalSlug = v; }\n',
    sandbox,
    { filename: 'test-shims.js' }
  );
  return sandbox;
}

function clipWithCurrent(current) {
  return { slug: 's1', name: 'Clip 1', fireshare: { current } };
}

function progressMsg(attemptId, seq, sentBytes, totalBytes) {
  return {
    type: 'fireshare_publish_progress',
    attempt_id: attemptId,
    slug: 's1',
    sent_bytes: sentBytes,
    total_bytes: totalBytes,
    progress: totalBytes ? sentBytes / totalBytes : 0,
    progress_pct: totalBytes ? (sentBytes / totalBytes) * 100 : 0,
    seq,
  };
}

function terminalMsg(type, attemptId, seq, extra) {
  return Object.assign({ type, attempt_id: attemptId, slug: 's1', seq }, extra || {});
}

function testProgressTickPatchesBarWithoutFullRerender() {
  const sandbox = makeSandbox();
  const clip = clipWithCurrent({ attempt_id: 'a1', state: 'uploading', progress_pct: 0, __seq: 1 });
  sandbox.clips = [clip];
  sandbox.__setModalSlug('s1');

  sandbox.onFireShareEvent(progressMsg('a1', 2, 50, 100));

  assert.strictEqual(sandbox.__renderClipsCalls.length, 0, 'a progress-only tick must not trigger a full clip-list rerender');
  assert.strictEqual(sandbox.__progressBarWidth(), '50%', 'the progress bar must still be patched in place');
  assert.strictEqual(clip.fireshare.current.state, 'uploading');
}

function testManyProgressTicksNeverRerenderClipList() {
  const sandbox = makeSandbox();
  const clip = clipWithCurrent({ attempt_id: 'a1', state: 'uploading', progress_pct: 0, __seq: 1 });
  sandbox.clips = [clip];
  sandbox.__setModalSlug('s1');

  for (let i = 0; i < 200; i += 1) {
    sandbox.onFireShareEvent(progressMsg('a1', i + 2, i + 1, 200));
  }

  assert.strictEqual(sandbox.__renderClipsCalls.length, 0, 'a burst of progress ticks must never call renderClips()');
  assert.strictEqual(sandbox.__progressBarWidth(), '100%');
}

function testStateTransitionRerendersOnlyPublishSurface() {
  const sandbox = makeSandbox();
  const clip = clipWithCurrent({ attempt_id: 'a1', state: 'uploading', progress_pct: 100, __seq: 5 });
  sandbox.clips = [clip];
  sandbox.__setModalSlug('s1');

  sandbox.onFireShareEvent(terminalMsg('fireshare_publish_processing', 'a1', 6, { state: 'processing' }));

  assert.strictEqual(sandbox.__renderClipsCalls.length, 0, 'clip cards have no FireShare state render dependency');
  assert.strictEqual(clip.fireshare.current.state, 'processing');
}

function testStaleProgressAfterReadyDoesNotRegressState() {
  const sandbox = makeSandbox();
  const clip = clipWithCurrent({ attempt_id: 'a1', state: 'ready', progress_pct: 100, __seq: 10 });
  sandbox.clips = [clip];
  sandbox.__setModalSlug('s1');

  // A late/queued progress broadcast (lower seq than the terminal state
  // already applied) must be rejected outright.
  sandbox.onFireShareEvent(progressMsg('a1', 7, 60, 100));

  assert.strictEqual(clip.fireshare.current.state, 'ready', 'a stale progress tick must not regress a terminal state');
  assert.strictEqual(clip.fireshare.current.progress_pct, 100);
  assert.strictEqual(sandbox.__renderClipsCalls.length, 0);
}

function testStaleProgressAfterCanceledDoesNotRegressState() {
  const sandbox = makeSandbox();
  const clip = clipWithCurrent({ attempt_id: 'a1', state: 'canceled', progress_pct: 42, __seq: 9 });
  sandbox.clips = [clip];
  sandbox.__setModalSlug('s1');

  sandbox.onFireShareEvent(progressMsg('a1', 8, 90, 100));

  assert.strictEqual(clip.fireshare.current.state, 'canceled', 'a stale progress tick must not regress a canceled state');
}

function testProgressFromSupersededAttemptIsRejected() {
  const sandbox = makeSandbox();
  // The clip has already moved on to a brand-new attempt (e.g. a retry);
  // a straggling broadcast tagged with the *old* attempt id must not
  // touch the currently-tracked (newer) attempt's state at all.
  const clip = clipWithCurrent({ attempt_id: 'new-attempt', state: 'uploading', progress_pct: 5, __seq: null });
  sandbox.clips = [clip];
  sandbox.__setModalSlug('s1');

  sandbox.onFireShareEvent(progressMsg('old-attempt', 99, 999, 1000));

  assert.strictEqual(clip.fireshare.current.attempt_id, 'new-attempt');
  assert.strictEqual(clip.fireshare.current.progress_pct, 5, 'the old attempt must not overwrite the new attempt\'s progress');
  assert.strictEqual(sandbox.__renderClipsCalls.length, 0);
}

function testRetryResetsSequenceBaselineForNewAttempt() {
  const sandbox = makeSandbox();
  // Simulate: attempt "old" ran up to seq 50, then the user retried,
  // producing a brand-new attempt id starting its own sequence from 1.
  const clip = clipWithCurrent({ attempt_id: 'old', state: 'failed', progress_pct: 100, __seq: 50 });
  sandbox.clips = [clip];
  sandbox.__setModalSlug('s1');

  // The retry HTTP response applies the fresh attempt directly (as
  // retryFireSharePublish() does), which must reset the __seq baseline so
  // the new attempt's own low-numbered events aren't rejected as "stale".
  sandbox.applyFireShareAttempt('s1', { attempt_id: 'new', state: 'uploading', progress_pct: 0 });
  assert.strictEqual(clip.fireshare.current.__seq, null, 'a brand-new attempt must not inherit the old sequence baseline');

  sandbox.onFireShareEvent(progressMsg('new', 1, 10, 100));

  assert.strictEqual(clip.fireshare.current.state, 'uploading');
  assert.strictEqual(clip.fireshare.current.progress_pct, 10, 'the new attempt\'s first progress tick must be accepted');
}

(async () => {
  testProgressTickPatchesBarWithoutFullRerender();
  testManyProgressTicksNeverRerenderClipList();
  testStateTransitionRerendersOnlyPublishSurface();
  testStaleProgressAfterReadyDoesNotRegressState();
  testStaleProgressAfterCanceledDoesNotRegressState();
  testProgressFromSupersededAttemptIsRejected();
  testRetryResetsSequenceBaselineForNewAttempt();
  console.log('ALL_JS_TESTS_OK');
})().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
"""


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class FireShareProgressUiBehaviorTests(unittest.TestCase):
    def test_progress_ui_behavior_via_node(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            harness_path = Path(tmp) / "fireshare_progress_harness.js"
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
