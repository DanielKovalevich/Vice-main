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

function element() {
  return {
    value: '',
    hidden: false,
    textContent: '',
    className: '',
    children: [],
    innerHTML: '',
    attrs: {},
    classList: { add() {} },
    setAttribute(name, value) { this.attrs[name] = value; },
    focus() {},
    querySelector() { return null; },
  };
}

function makeSandbox(defaultFolder = '') {
  const ids = [
    's-fireshare-default-folder', 's-fireshare-folder-search', 's-fireshare-folder-list',
    's-fireshare-folder-status', 's-fireshare-folder-retry', 's-fireshare-folder-create',
    's-fireshare-folder-new', 's-fireshare-folder-error',
    'fireshare-publish-folder', 'fireshare-publish-folder-search', 'fireshare-publish-folder-list',
    'fireshare-publish-folder-status', 'fireshare-publish-folder-retry',
    'fireshare-publish-folder-create', 'fireshare-publish-folder-new',
    'fireshare-publish-folder-error',
  ];
  const elements = Object.fromEntries(ids.map(id => [id, element()]));
  const requests = [];
  const sandbox = {
    console,
    cfg: {
      fireshare: {
        base_url: 'https://fireshare.example.com',
        token_configured: true,
        default_folder: defaultFolder,
      },
    },
    clips: [],
    toast() {},
    setText() {},
    escHtml: value => String(value),
    requestAnimationFrame: callback => callback(),
    document: {
      activeElement: null,
      getElementById: id => elements[id] || null,
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({
          ok: true,
          default_folder: 'uploads',
          folders: ['clips', 'vice'],
        }),
      };
    },
    __elements: elements,
    __requests: requests,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'fireshare.js' });
  vm.runInContext(
    'function __setModalSlug(v) { fireshareModalSlug = v; }\n' +
    'function __directoryState() { return fireshareFolderDirectory.state; }\n' +
    'function __directoryDefault() { return fireshareFolderDirectory.defaultFolder; }\n',
    sandbox,
  );
  return sandbox;
}

async function testExistingSelectionAndServerDefault() {
  const sandbox = makeSandbox('');
  sandbox.__setModalSlug('clip-1');
  sandbox.initializeFireShareFolderPicker('publish', '');
  await sandbox.loadFireShareFolders();

  assert.strictEqual(sandbox.__requests.length, 1);
  assert.strictEqual(sandbox.__requests[0].url, '/api/fireshare/folders');
  assert.strictEqual(sandbox.__requests[0].options.cache, 'no-store');
  assert.strictEqual(sandbox.readFireShareFolder('publish'), 'uploads');

  sandbox.selectFireShareFolder('publish', 'vice');
  assert.strictEqual(sandbox.readFireShareFolder('publish'), 'vice');

  sandbox.initializeFireShareFolderPicker('publish', '');
  await sandbox.loadFireShareFolders();
  assert.strictEqual(sandbox.__requests.length, 1, 'the loaded folder list should be reused');
}

function testViceDefaultWinsAndCreateValidationIsExact() {
  const sandbox = makeSandbox('clips');
  sandbox.initializeFireShareFolderPicker('publish', 'clips');
  assert.strictEqual(sandbox.readFireShareFolder('publish'), 'clips');

  sandbox.beginFireShareFolderCreate('publish');
  sandbox.__elements['fireshare-publish-folder-new'].value = 'bad folder';
  assert.throws(
    () => sandbox.readFireShareFolder('publish'),
    /1-128 letters, numbers, underscores, or hyphens/,
  );
  assert.strictEqual(sandbox.__elements['fireshare-publish-folder-error'].hidden, false);

  sandbox.__elements['fireshare-publish-folder-new'].value = 'new_folder-2';
  assert.strictEqual(sandbox.confirmFireShareFolderCreate('publish'), true);
  assert.strictEqual(sandbox.readFireShareFolder('publish'), 'new_folder-2');
}

async function testOfflineStillAllowsExplicitCreateAndRetry() {
  const sandbox = makeSandbox('');
  sandbox.fetch = async () => { throw new Error('offline'); };
  await sandbox.loadFireShareFolders();

  assert.strictEqual(sandbox.__directoryState(), 'error');
  assert.match(sandbox.__elements['fireshare-publish-folder-status'].textContent, /Folders unavailable: offline/);
  assert.strictEqual(sandbox.__elements['fireshare-publish-folder-retry'].hidden, false);

  sandbox.beginFireShareFolderCreate('publish');
  sandbox.__elements['fireshare-publish-folder-new'].value = 'offline_folder';
  assert.strictEqual(sandbox.confirmFireShareFolderCreate('publish'), true);
  assert.strictEqual(sandbox.readFireShareFolder('publish'), 'offline_folder');
}

async function testForcedReloadQueuesBehindInFlightRequest() {
  const sandbox = makeSandbox('');
  sandbox.__setModalSlug('clip-1');
  sandbox.initializeFireShareFolderPicker('publish', '');
  let resolveFirst;
  sandbox.fetch = async () => {
    const call = sandbox.__requests.length;
    sandbox.__requests.push({ call });
    if (call === 0) {
      await new Promise(resolve => { resolveFirst = resolve; });
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({
        ok: true,
        default_folder: call === 0 ? 'old' : 'new',
        folders: [],
      }),
    };
  };
  const first = sandbox.loadFireShareFolders();
  const forced = sandbox.loadFireShareFolders(true);
  resolveFirst();
  await Promise.all([first, forced]);
  assert.strictEqual(sandbox.__requests.length, 2, 'forced reload must run after the in-flight request');
  assert.strictEqual(sandbox.__directoryDefault(), 'new');
  assert.strictEqual(sandbox.readFireShareFolder('publish'), 'new', 'untouched server-default selections must refresh');
}

(async () => {
  await testExistingSelectionAndServerDefault();
  testViceDefaultWinsAndCreateValidationIsExact();
  await testOfflineStillAllowsExplicitCreateAndRetry();
  await testForcedReloadQueuesBehindInFlightRequest();
  console.log('ALL_FOLDER_UI_TESTS_OK');
})().catch(err => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
"""


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class FireShareFolderUiTests(unittest.TestCase):
    def test_folder_picker_behavior_via_node(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            harness_path = Path(tmp) / "fireshare_folders_harness.js"
            harness_path.write_text(NODE_HARNESS, encoding="utf-8")
            result = subprocess.run(
                ["node", str(harness_path), str(FIRESHARE_JS)],
                capture_output=True,
                text=True,
                timeout=30,
            )
        self.assertEqual(
            result.returncode,
            0,
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}",
        )
        self.assertIn("ALL_FOLDER_UI_TESTS_OK", result.stdout)


if __name__ == "__main__":
    unittest.main()
