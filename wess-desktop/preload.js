const { contextBridge, ipcRenderer } = require('electron');

const channelSubscriptions = new Map();

function subscribe(channel, cb) {
  const previous = channelSubscriptions.get(channel);
  if (previous) ipcRenderer.removeListener(channel, previous);
  const listener = (_event, data) => cb(data);
  channelSubscriptions.set(channel, listener);
  ipcRenderer.on(channel, listener);
  return () => {
    if (channelSubscriptions.get(channel) !== listener) return;
    channelSubscriptions.delete(channel);
    ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('wess', {
  send: (text, model, intelligence, wireText, silent, expectUrl, convId, msgId) =>
    ipcRenderer.send('send-message', { text, model, intelligence, wireText, silent, expectUrl, convId, msgId }),
  editMessage: (payload) => ipcRenderer.send('edit-message', payload),
  sendFiles: (convId, files) => ipcRenderer.send('send-files', { convId, files }),
  debugDom: () => ipcRenderer.send('debug-dom'),
  newChat: (convId) => ipcRenderer.send('new-chat', { convId }),
  navigate: (url, convId) => ipcRenderer.send('navigate', { url, convId }),
  switchModel: (model, intelligence, convId) =>
    ipcRenderer.send('switch-model', { model, intelligence, convId }),
  log: (scope, msg, extra) => ipcRenderer.send('wess-log', { scope, msg, extra }),

  saveData: (data) => ipcRenderer.invoke('save-data', data),
  loadData: () => ipcRenderer.invoke('load-data'),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  agentExec: (payload) => ipcRenderer.invoke('agent-exec', payload),
  openInEditor: (editorId, cwd) => ipcRenderer.send('open-in-editor', { editorId, cwd }),
  detectEditors: () => ipcRenderer.invoke('detect-editors'),
  stopGenerating: (convId) => ipcRenderer.send('stop-generating', convId),
  previewOpenExternal: (url) => ipcRenderer.invoke('preview-open-external', url),
  previewClearCookies: () => ipcRenderer.invoke('preview-clear-cookies'),
  previewClearCache: () => ipcRenderer.invoke('preview-clear-cache'),
  previewListServers: () => ipcRenderer.invoke('preview-list-servers'),
  previewStartRecording: (webContentsId) =>
    ipcRenderer.invoke('preview-recording-start', { webContentsId }),
  previewStopRecording: (webContentsId) =>
    ipcRenderer.invoke('preview-recording-stop', { webContentsId }),
  previewSaveRecording: (data, mime) =>
    ipcRenderer.invoke('preview-save-recording', { data, mime }),
  getUpdateStatus: () => ipcRenderer.invoke('app-update-status'),
  checkForUpdates: () => ipcRenderer.invoke('app-update-check'),
  installUpdate: () => ipcRenderer.send('app-update-install'),
  onPreviewRecordingFrame: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on('preview-recording-frame', listener);
    return () => ipcRenderer.removeListener('preview-recording-frame', listener);
  },

  onSent: (cb) => subscribe('sent', cb),
  onModels: (cb) => subscribe('models', cb),
  onSelectionError: (cb) => subscribe('selection_error', cb),
  onResponse: (cb) => subscribe('response', cb),
  onStreamUpdate: (cb) => subscribe('stream_update', cb),
  onError: (cb) => subscribe('error', cb),
  onWrongConversation: (cb) => subscribe('wrong_conversation', cb),
  onStatus: (cb) => subscribe('status', cb),
  onDebugResult: (cb) => subscribe('debug_result', cb),
  onAgentExecProgress: (cb) => subscribe('agent_exec_progress', cb),
  onUpdateStatus: (cb) => subscribe('app-update-status', cb),

  ready: () => ipcRenderer.send('wess-ready'),

  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),
});
