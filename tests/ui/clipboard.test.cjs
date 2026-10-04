const assert = require('node:assert/strict');
const path = require('node:path');

const output = process.argv[2];
const clipboardModule = path.join(output, 'clipboard.js');
const envModule = path.join(output, 'env.js');
const url = 'https://clips.example/w/recording';

async function check({native, bridge, browser, secure = true, legacy = true, expected, route}) {
  const calls = [];
  global.location = {search: native ? '?native=1' : ''};
  global.window = {isSecureContext: secure};
  if (bridge) window.pywebview = {api: {copy_to_clipboard: async text => {
    calls.push(['native', text]);
    return bridge();
  }}};
  Object.defineProperty(global, 'navigator', {configurable: true, value: {
    clipboard: browser ? {writeText: async text => {
      calls.push(['browser', text]);
      return browser();
    }} : undefined,
  }});
  const nodes = new Set();
  global.document = {
    createElement: () => ({value: '', style: {}, canPlayType: () => 'probably',
      setAttribute() {}, select() {calls.push(['select', this.value]);}}),
    body: {appendChild(node) {nodes.add(node);}, removeChild(node) {nodes.delete(node);}},
    execCommand(cmd) {calls.push(['legacy', cmd]); return legacy;},
  };
  delete require.cache[clipboardModule];
  delete require.cache[envModule];
  const {copyToClipboard} = require(clipboardModule);
  assert.equal(await copyToClipboard(url), expected);
  assert.deepEqual(calls.map(([name]) => name), route);
  for (const [name, text] of calls) {
    if (name === 'native' || name === 'browser' || name === 'select') assert.equal(text, url);
  }
  assert.equal(nodes.size, 0, 'temporary text field must be removed');
  assert.equal(await copyToClipboard(''), false);
}

(async () => {
  await check({native: true, bridge: () => true, browser: () => {},
    expected: true, route: ['native']});
  await check({native: true, bridge: () => false, browser: () => {},
    expected: true, route: ['native', 'browser']});
  await check({native: true, bridge: () => {throw Error('bridge unavailable');}, browser: () => {},
    expected: true, route: ['native', 'browser']});
  await check({native: true, expected: true, route: ['select', 'legacy']});
  await check({browser: () => {}, expected: true, route: ['browser']});
  await check({browser: () => {throw Error('permission denied');},
    expected: true, route: ['browser', 'select', 'legacy']});
  await check({secure: false, browser: () => {throw Error('must not be used');},
    expected: true, route: ['select', 'legacy']});
  await check({native: true, bridge: () => false, secure: false, legacy: false,
    expected: false, route: ['native', 'select', 'legacy']});
  console.log('OK clipboard fallbacks');
})().catch(error => {console.error(error); process.exitCode = 1;});
