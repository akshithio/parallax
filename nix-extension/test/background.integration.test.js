const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function loadBackground(options = {}) {
  const stored = { ...(options.stored || {}) };
  const tabs = new Map(options.tabs || []);
  const updates = [];
  const creates = [];
  let nextTabId = 100;

  const event = () => ({ addListener() {}, removeListener() {} });
  const chrome = {
    storage: {
      local: {
        get(keys, callback) {
          const names = Array.isArray(keys) ? keys : [keys];
          const result = Object.fromEntries(
            names.filter((name) => Object.hasOwn(stored, name)).map((name) => [name, stored[name]]),
          );
          queueMicrotask(() => callback(result));
        },
        set(value, callback) {
          Object.assign(stored, value);
          if (callback) callback();
        },
        remove(key, callback) {
          delete stored[key];
          if (callback) callback();
        },
      },
    },
    tabs: {
      async get(tabId) {
        if (!tabs.has(tabId)) throw new Error('missing tab');
        return tabs.get(tabId);
      },
      async update(tabId, update) {
        const current = tabs.get(tabId);
        if (!current) throw new Error('missing tab');
        const changed = { ...current, ...update };
        tabs.set(tabId, changed);
        updates.push({ tabId, update });
        return changed;
      },
      async create(create) {
        const tab = { id: nextTabId++, status: 'complete', ...create };
        tabs.set(tab.id, tab);
        creates.push(create);
        return tab;
      },
      async reload() {},
      onRemoved: event(),
      onUpdated: event(),
    },
    scripting: {
      async executeScript() {},
    },
    runtime: {
      reload() {},
      onConnect: event(),
      onMessage: event(),
      onStartup: event(),
      onInstalled: event(),
    },
    alarms: {
      create() {},
      onAlarm: event(),
    },
  };

  class FakeWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor() {
      this.readyState = FakeWebSocket.CONNECTING;
    }
    send() {}
    close() {}
  }

  const context = vm.createContext({
    chrome,
    WebSocket: FakeWebSocket,
    console,
    crypto,
    queueMicrotask,
    setTimeout: () => 0,
    clearTimeout() {},
    self: { addEventListener() {} },
  });
  const file = path.join(__dirname, '..', 'src', 'background.js');
  const source =
    fs.readFileSync(file, 'utf8') +
    '\n;globalThis.__backgroundTest = {' +
    'storageReady, mapConvTab, handleNavigate,' +
    'rememberTurn, acceptTurn, settleTurn, recoveryMessageForConversation,' +
    'getConvTabs: () => ({ ...convTabs }),' +
    'getTabConv: () => Array.from(tabConv.entries())' +
    '};';
  vm.runInContext(source, context, { filename: file });
  await context.__backgroundTest.storageReady;

  return {
    api: context.__backgroundTest,
    tabs,
    updates,
    creates,
    stored,
  };
}

test('background keeps task-to-tab ownership one-to-one', async () => {
  const harness = await loadBackground({
    tabs: [
      [1, { id: 1, url: 'https://chatgpt.com/c/one', status: 'complete' }],
      [2, { id: 2, url: 'https://chatgpt.com/c/two', status: 'complete' }],
    ],
  });

  harness.api.mapConvTab('thread-a', 1);
  harness.api.mapConvTab('thread-b', 1);
  assert.deepEqual(plain(harness.api.getConvTabs()), { 'thread-b': 1 });
  assert.deepEqual(plain(harness.api.getTabConv()), [[1, 'thread-b']]);

  harness.api.mapConvTab('thread-b', 2);
  assert.deepEqual(plain(harness.api.getConvTabs()), { 'thread-b': 2 });
  assert.deepEqual(plain(harness.api.getTabConv()), [[2, 'thread-b']]);
});

test('background navigates the owned tab instead of silently accepting drift', async () => {
  const harness = await loadBackground({
    tabs: [[1, { id: 1, url: 'https://chatgpt.com/c/wrong', status: 'complete' }]],
  });
  const expected = 'https://chatgpt.com/c/expected';
  harness.api.mapConvTab('thread-a', 1);

  await harness.api.handleNavigate(expected, 'thread-a');
  assert.deepEqual(plain(harness.updates), [
    { tabId: 1, update: { url: expected, active: false } },
  ]);

  await harness.api.handleNavigate(expected, 'thread-a');
  assert.equal(harness.updates.length, 1);
});

test('background recreates a missing owned tab at the stored task URL', async () => {
  const harness = await loadBackground();
  const expected = 'https://chatgpt.com/c/recreated';
  harness.api.mapConvTab('thread-a', 42);

  await harness.api.handleNavigate(expected, 'thread-a');
  assert.deepEqual(plain(harness.creates), [{ url: expected, active: false }]);
  assert.deepEqual(plain(harness.api.getConvTabs()), { 'thread-a': 100 });
});

test('background retains an accepted turn for page-bridge recovery until it settles', async () => {
  const harness = await loadBackground();
  const message = {
    text: 'go ahead and do it then?',
    expectUrl: 'https://chatgpt.com/c/recovery',
  };

  harness.api.rememberTurn('thread-a', 7, message, 'turn-1');
  assert.equal(harness.api.recoveryMessageForConversation('thread-a'), null);

  assert.equal(harness.api.acceptTurn('thread-a', 'turn-1'), true);
  assert.deepEqual(plain(harness.api.recoveryMessageForConversation('thread-a')), {
    type: 'recover_turn',
    msgId: 'turn-1',
    text: message.text,
    expectUrl: message.expectUrl,
  });

  assert.equal(harness.api.settleTurn('thread-a', 'turn-1'), true);
  assert.equal(harness.api.recoveryMessageForConversation('thread-a'), null);
});
