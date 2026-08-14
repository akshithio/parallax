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
  const scriptResults = options.scriptResults || [];
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
      async executeScript() { return scriptResults; },
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
    URL,
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
    'storageReady, mapConvTab, handleNavigate, handleNewChat, tabForConversation,' +
    'canonicalProjectUrl, mapFolderProject, resolveFolderProject,' +
    'stageFiles, takeStagedFiles, contentScriptPresent,' +
    'rememberTurn, acceptTurn, settleTurn, recoveryMessageForConversation,' +
    'getConvTabs: () => ({ ...convTabs }),' +
    'getFolderProjects: () => ({ ...folderProjects }),' +
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

test('background detects a live isolated content script before recovery injection', async () => {
  const harness = await loadBackground({ scriptResults: [{ result: true }] });
  assert.equal(await harness.api.contentScriptPresent(7), true);
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

test('background persists one ChatGPT Project route per desktop folder', async () => {
  const harness = await loadBackground();
  const projectUrl =
    'https://chatgpt.com/g/g-p-67710a876dac8191bd024ba6d5725bb8/project/settings';

  const mapped = harness.api.mapFolderProject(
    '/Users/example/Developer/parallax',
    'plx-parallax',
    projectUrl,
  );

  assert.deepEqual(plain(mapped), {
    name: 'plx-parallax',
    url: 'https://chatgpt.com/g/g-p-67710a876dac8191bd024ba6d5725bb8/project',
  });
  assert.deepEqual(plain(harness.stored.parallax_folder_projects), {
    '/Users/example/Developer/parallax': {
      name: 'plx-parallax',
      url: 'https://chatgpt.com/g/g-p-67710a876dac8191bd024ba6d5725bb8/project',
    },
  });

  const opened = await harness.api.tabForConversation(
    'thread-a',
    null,
    '/Users/example/Developer/parallax',
  );
  assert.equal(opened.created, true);
  assert.deepEqual(plain(harness.creates), [{
    url: mapped.url,
    active: false,
  }]);
});

test('background reuses a known project name when the desktop folder key changes', async () => {
  const projectUrl =
    'https://chatgpt.com/g/g-p-67710a876dac8191bd024ba6d5725bb8/project';
  const harness = await loadBackground({
    stored: {
      parallax_folder_projects: {
        '/old/path/parallax': { name: 'plx-parallax', url: projectUrl },
      },
    },
  });

  const project = await harness.api.resolveFolderProject(
    7,
    null,
    '/new/path/parallax',
    'plx-parallax',
  );

  assert.deepEqual(plain(project), { name: 'plx-parallax', url: projectUrl });
  assert.deepEqual(plain(harness.api.getFolderProjects()['/new/path/parallax']), {
    name: 'plx-parallax',
    url: projectUrl,
  });
});

test('opening an empty desktop draft does not open or create a ChatGPT Project', async () => {
  const harness = await loadBackground({
    stored: {
      parallax_folder_projects: {
        '/Users/example/Developer/parallax': {
          name: 'plx-parallax',
          url: 'https://chatgpt.com/g/g-p-67710a876dac8191bd024ba6d5725bb8/project',
        },
      },
    },
  });

  await harness.api.handleNewChat('thread-a');

  assert.deepEqual(plain(harness.creates), []);
  assert.deepEqual(plain(harness.api.getConvTabs()), {});
});

test('file selection is staged locally until the matching message send', async () => {
  const harness = await loadBackground();
  const first = [{ name: 'first.txt' }];
  const replacement = [{ name: 'replacement.txt' }];

  assert.equal(harness.api.stageFiles('thread-a', first), 1);
  assert.equal(harness.api.stageFiles('thread-a', replacement), 1);
  assert.deepEqual(plain(harness.creates), []);
  assert.deepEqual(plain(harness.api.takeStagedFiles('thread-a')), replacement);
  assert.deepEqual(plain(harness.api.takeStagedFiles('thread-a')), []);
});

test('background resumes an unaccepted turn and recovers it after acceptance', async () => {
  const harness = await loadBackground();
  const message = {
    text: 'go ahead and do it then?',
    model: 'GPT-5.6 Sol',
    intelligence: 'High',
    expectUrl: 'https://chatgpt.com/c/recovery',
  };
  const files = [{ name: 'notes.txt' }];

  harness.api.rememberTurn('thread-a', 7, message, 'turn-1', files);
  assert.deepEqual(plain(harness.api.recoveryMessageForConversation('thread-a')), {
    type: 'resume_pending_turn',
    msgId: 'turn-1',
    text: message.text,
    model: message.model,
    intelligence: message.intelligence,
    expectUrl: message.expectUrl,
    files,
    attachmentsLost: false,
  });
  assert.equal(harness.stored.parallax_active_turns['thread-a'].msgId, 'turn-1');
  assert.deepEqual(plain(harness.stored.parallax_active_turns['thread-a'].files), []);
  assert.equal(harness.stored.parallax_active_turns['thread-a'].attachmentsLost, true);

  assert.equal(harness.api.acceptTurn('thread-a', 'turn-1'), true);
  assert.deepEqual(plain(harness.api.recoveryMessageForConversation('thread-a')), {
    type: 'recover_turn',
    msgId: 'turn-1',
    text: message.text,
    expectUrl: message.expectUrl,
  });

  assert.equal(harness.api.settleTurn('thread-a', 'turn-1'), true);
  assert.equal(harness.api.recoveryMessageForConversation('thread-a'), null);
  assert.deepEqual(plain(harness.stored.parallax_active_turns), {});
});
