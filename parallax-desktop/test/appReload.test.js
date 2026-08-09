const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isReloadShortcut,
  installAppReloadShortcut,
} = require('../lib/appReload');

test('recognizes app reload shortcuts without consuming ordinary typing', () => {
  assert.equal(isReloadShortcut({ type: 'keyDown', key: 'r', meta: true }), true);
  assert.equal(isReloadShortcut({ type: 'keyDown', key: 'R', control: true }), true);
  assert.equal(isReloadShortcut({ type: 'keyUp', key: 'r', meta: true }), false);
  assert.equal(isReloadShortcut({ type: 'keyDown', key: 'r' }), false);
  assert.equal(isReloadShortcut({ type: 'keyDown', key: 'k', meta: true }), false);
});

test('reload shortcut always loads the canonical app shell', async () => {
  let handler;
  let prevented = false;
  let beforeReloadCalls = 0;
  const loaded = [];
  const contents = {
    on(event, callback) {
      assert.equal(event, 'before-input-event');
      handler = callback;
    },
    async loadURL(url) {
      loaded.push(url);
    },
  };

  installAppReloadShortcut(
    contents,
    'http://localhost:3000/',
    () => { beforeReloadCalls += 1; },
  );
  handler(
    { preventDefault() { prevented = true; } },
    { type: 'keyDown', key: 'r', meta: true },
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(prevented, true);
  assert.equal(beforeReloadCalls, 1);
  assert.deepEqual(loaded, ['http://localhost:3000/']);
});
