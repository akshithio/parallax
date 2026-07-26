function isReloadShortcut(input) {
  if (!input || input.type !== 'keyDown') return false;
  if (String(input.key || '').toLowerCase() !== 'r') return false;
  return Boolean(input.meta || input.control);
}

function installAppReloadShortcut(contents, appUrl, beforeReload) {
  contents.on('before-input-event', (event, input) => {
    if (!isReloadShortcut(input)) return;
    event.preventDefault();
    if (typeof beforeReload === 'function') beforeReload();
    Promise.resolve(contents.loadURL(appUrl)).catch(() => {});
  });
}

module.exports = { isReloadShortcut, installAppReloadShortcut };
