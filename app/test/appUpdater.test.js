const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createAppUpdater } = require('../lib/appUpdater');

class TestUpdater extends EventEmitter {
  constructor() {
    super();
    this.autoDownload = false;
    this.autoInstallOnAppQuit = false;
    this.checkCalls = 0;
    this.installCalls = [];
    this.checkError = null;
  }

  async checkForUpdates() {
    this.checkCalls += 1;
    if (this.checkError) throw this.checkError;
    return null;
  }

  quitAndInstall(...args) {
    this.installCalls.push(args);
  }
}

function setup({ packaged = true } = {}) {
  const autoUpdater = new TestUpdater();
  const sent = [];
  const timeouts = [];
  const intervals = [];
  const errors = [];
  const updater = createAppUpdater({
    app: {
      isPackaged: packaged,
      getVersion: () => '1.2.3',
    },
    autoUpdater,
    send: (state) => sent.push(state),
    logger: { error: (message) => errors.push(message) },
    setTimeoutFn: (callback) => {
      timeouts.push(callback);
      return timeouts.length;
    },
    clearTimeoutFn: () => {},
    setIntervalFn: (callback) => {
      intervals.push(callback);
      return intervals.length;
    },
    clearIntervalFn: () => {},
  });
  return { autoUpdater, errors, intervals, sent, timeouts, updater };
}

test('disables update checks in development builds', async () => {
  const { autoUpdater, sent, timeouts, updater } = setup({ packaged: false });

  assert.equal(updater.start().status, 'disabled');
  assert.equal((await updater.check()).status, 'disabled');
  assert.equal(autoUpdater.checkCalls, 0);
  assert.equal(timeouts.length, 0);
  assert.equal(sent.at(-1).currentVersion, '1.2.3');
});

test('checks on startup and reports download progress to the renderer', async () => {
  const { autoUpdater, intervals, sent, timeouts, updater } = setup();
  updater.start();

  assert.equal(autoUpdater.autoDownload, true);
  assert.equal(autoUpdater.autoInstallOnAppQuit, true);
  assert.equal(timeouts.length, 1);
  assert.equal(intervals.length, 1);

  await timeouts[0]();
  assert.equal(autoUpdater.checkCalls, 1);
  assert.equal(sent.at(-1).status, 'checking');

  autoUpdater.emit('update-available', { version: '1.3.0' });
  assert.equal(sent.at(-1).status, 'downloading');
  assert.equal(sent.at(-1).availableVersion, '1.3.0');

  autoUpdater.emit('download-progress', { percent: 51.6 });
  assert.equal(sent.at(-1).progress, 51.6);
  assert.match(sent.at(-1).message, /52%/);

  autoUpdater.emit('update-downloaded', { version: '1.3.0' });
  assert.equal(updater.getState().status, 'downloaded');
  assert.equal(updater.getState().progress, 100);
});

test('installs only after an update has downloaded', () => {
  const { autoUpdater, updater } = setup();
  updater.start();

  assert.equal(updater.install(), false);
  autoUpdater.emit('update-downloaded', { version: '1.3.0' });
  assert.equal(updater.install(), true);
  assert.deepEqual(autoUpdater.installCalls, [[false, true]]);
  assert.equal(updater.getState().status, 'installing');
});

test('turns failed checks into a visible recoverable state', async () => {
  const { autoUpdater, errors, updater } = setup();
  updater.start();
  autoUpdater.checkError = new Error('release feed unavailable');

  const state = await updater.check();
  assert.equal(state.status, 'error');
  assert.equal(state.message, 'release feed unavailable');
  assert.match(errors.at(-1), /release feed unavailable/);

  autoUpdater.checkError = null;
  await updater.check();
  assert.equal(autoUpdater.checkCalls, 2);
  assert.equal(updater.getState().status, 'checking');
});
