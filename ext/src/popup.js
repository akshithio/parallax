const el = (id) => document.getElementById(id);
const wsDot = el('ws-dot');
const wsLabel = el('ws-label');
const tabDot = el('tab-dot');
const tabLabel = el('tab-label');
const contentDot = el('content-dot');
const contentLabel = el('content-label');
const wsUrlInput = el('ws-url');
const connectBtn = el('connect-btn');
const errorMsg = el('error-msg');
const hint = el('hint');
const enableBtn = el('enable-btn');
const disableBtn = el('disable-btn');
const bridgeControls = el('bridge-controls');

function paint(dot, label, state, text) {
  dot.className = 'dot ' + state;
  label.textContent = text;
}

let urlDirty = false;
wsUrlInput.addEventListener('input', () => { urlDirty = true; });

async function refresh() {
  // Is a ChatGPT tab actually open?
  let tabOpen = false;
  try {
    const tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'] });
    tabOpen = tabs.length > 0;
  } catch {}
  paint(tabDot, tabLabel, tabOpen ? 'ok' : '', tabOpen ? 'Open' : 'Opens on demand');

  let ws = 'disconnected';
  let content = false;
  let error = '';
  let enabled = false;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'get_status' });
    if (resp) {
      enabled = Boolean(resp.enabled);
      ws = resp.ws;
      content = Boolean(resp.content);
      error = resp.error || '';
      if (!urlDirty && resp.url) wsUrlInput.value = resp.url;
    }
  } catch {}

  enableBtn.hidden = enabled;
  bridgeControls.hidden = !enabled;
  if (!enabled) return;

  const wsOk = ws === 'connected';
  paint(wsDot, wsLabel, wsOk ? 'ok' : 'bad', wsOk ? 'Connected' : ws === 'error' ? 'Error' : 'Disconnected');
  // An idle page bridge is normal. The desktop send path creates or recovers its
  // owned ChatGPT task tab and waits for the content script automatically.
  paint(
    contentDot,
    contentLabel,
    content ? 'ok' : '',
    content ? 'Connected' : wsOk ? 'Ready on demand' : 'Waiting for desktop',
  );

  errorMsg.textContent = error;
  hint.textContent = !wsOk
    ? 'Start the Parallax desktop app, then hit Reconnect.'
    : !content
      ? 'No action is required. Parallax connects a task tab automatically when you send a message from the desktop app.'
      : '';
}

enableBtn.addEventListener('click', () => {
  enableBtn.disabled = true;
  chrome.runtime.sendMessage({ type: 'set_bridge_enabled', enabled: true }, () => {
    enableBtn.disabled = false;
    refresh();
  });
});

disableBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'set_bridge_enabled', enabled: false }, refresh);
});

connectBtn.addEventListener('click', () => {
  errorMsg.textContent = '';
  const url = wsUrlInput.value.trim();
  if (!url) {
    errorMsg.textContent = 'Enter a WebSocket URL';
    return;
  }
  chrome.runtime.sendMessage({ type: 'connect_ws', url }, (resp) => {
    urlDirty = false;
    if (!resp || !resp.ok) errorMsg.textContent = 'Failed to connect';
    refresh();
  });
});

refresh();
setInterval(refresh, 2000);
