const DEFAULT_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const STARTUP_CHECK_DELAY_MS = 5000;

function normalizeError(error) {
  if (!error) return 'The update check failed.';
  return String(error.message || error).replace(/^Error:\s*/i, '').trim();
}

function createAppUpdater({
  app,
  autoUpdater,
  send,
  logger = console,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  startupDelayMs = STARTUP_CHECK_DELAY_MS,
  checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
}) {
  let state = {
    status: app.isPackaged ? 'idle' : 'disabled',
    currentVersion: app.getVersion(),
    availableVersion: '',
    progress: null,
    message: app.isPackaged
      ? 'Nix checks for updates automatically.'
      : 'Update checks are available in installed builds.',
  };
  let started = false;
  let startupTimer = null;
  let intervalTimer = null;
  const listeners = [];

  function publish(patch) {
    state = { ...state, ...patch };
    send({ ...state });
    return { ...state };
  }

  function listen(event, handler) {
    autoUpdater.on(event, handler);
    listeners.push([event, handler]);
  }

  async function check() {
    if (!app.isPackaged) return { ...state };
    if (['checking', 'downloading', 'installing'].includes(state.status)) return { ...state };

    publish({
      status: 'checking',
      progress: null,
      message: 'Checking for updates…',
    });
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      logger.error?.(`Update check failed: ${normalizeError(error)}`);
      publish({
        status: 'error',
        progress: null,
        message: normalizeError(error),
      });
    }
    return { ...state };
  }

  function install() {
    if (state.status !== 'downloaded') return false;
    publish({ status: 'installing', message: 'Restarting to install the update…' });
    autoUpdater.quitAndInstall(false, true);
    return true;
  }

  function start() {
    if (started || !app.isPackaged) {
      send({ ...state });
      return { ...state };
    }
    started = true;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    listen('checking-for-update', () => {
      publish({ status: 'checking', progress: null, message: 'Checking for updates…' });
    });
    listen('update-available', (info) => {
      publish({
        status: 'downloading',
        availableVersion: info?.version || state.availableVersion,
        progress: 0,
        message: `Downloading Nix ${info?.version || 'update'}…`,
      });
    });
    listen('update-not-available', () => {
      publish({
        status: 'up-to-date',
        availableVersion: '',
        progress: null,
        message: 'Nix is up to date.',
      });
    });
    listen('download-progress', (progress) => {
      const percent = Math.max(0, Math.min(100, Number(progress?.percent) || 0));
      publish({
        status: 'downloading',
        progress: percent,
        message: `Downloading update… ${Math.round(percent)}%`,
      });
    });
    listen('update-downloaded', (info) => {
      publish({
        status: 'downloaded',
        availableVersion: info?.version || state.availableVersion,
        progress: 100,
        message: `Nix ${info?.version || 'update'} is ready to install.`,
      });
    });
    listen('error', (error) => {
      logger.error?.(`Updater error: ${normalizeError(error)}`);
      publish({
        status: 'error',
        progress: null,
        message: normalizeError(error),
      });
    });

    startupTimer = setTimeoutFn(() => void check(), startupDelayMs);
    intervalTimer = setIntervalFn(() => void check(), checkIntervalMs);
    send({ ...state });
    return { ...state };
  }

  function dispose() {
    if (startupTimer !== null) clearTimeoutFn(startupTimer);
    if (intervalTimer !== null) clearIntervalFn(intervalTimer);
    startupTimer = null;
    intervalTimer = null;
    for (const [event, handler] of listeners) {
      autoUpdater.removeListener(event, handler);
    }
    listeners.length = 0;
    started = false;
  }

  return {
    start,
    check,
    install,
    dispose,
    getState: () => ({ ...state }),
  };
}

module.exports = {
  DEFAULT_CHECK_INTERVAL_MS,
  STARTUP_CHECK_DELAY_MS,
  createAppUpdater,
  normalizeError,
};
