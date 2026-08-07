const el = (id) => document.getElementById(id);
const wsDot = el('ws-dot');
const wsLabel = el('ws-label');
const tabDot = el('tab-dot');
const tabLabel = el('tab-label');
const contentDot = el('content-dot');
const contentLabel = el('content-label');
const wsUrlInput = el('ws-url');
const connectBtn = el('connect-btn');
const healBtn = el('heal-btn');
const errorMsg = el('error-msg');
const hint = el('hint');

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
  paint(tabDot, tabLabel, tabOpen ? 'ok' : 'bad', tabOpen ? 'Open' : 'Not open');

  let ws = 'disconnected';
  let content = false;
  let error = '';
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'get_status' });
    if (resp) {
      ws = resp.ws;
      content = Boolean(resp.content);
      error = resp.error || '';
      if (!urlDirty && resp.url) wsUrlInput.value = resp.url;
    }
  } catch {}

  const wsOk = ws === 'connected';
  paint(wsDot, wsLabel, wsOk ? 'ok' : 'bad', wsOk ? 'Connected' : ws === 'error' ? 'Error' : 'Disconnected');
  // The page bridge is the piece that silently breaks after an extension reload —
  // surface it on its own instead of implying "connected" from the socket alone.
  paint(contentDot, contentLabel, content ? 'ok' : wsOk && tabOpen ? 'warn' : 'bad', content ? 'Connected' : 'Not connected');

  healBtn.style.display = content ? 'none' : 'block';
  healBtn.disabled = !tabOpen;

  errorMsg.textContent = error;
  hint.textContent = !wsOk
    ? 'Start the Nix desktop app, then hit Reconnect.'
    : !tabOpen
      ? 'Open ChatGPT in a tab so Nix has a page to drive.'
      : !content
        ? 'The ChatGPT page isn’t bridged — this happens after reloading the extension. Reconnect it below.'
        : '';
}

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

healBtn.addEventListener('click', () => {
  errorMsg.textContent = '';
  healBtn.disabled = true;
  healBtn.textContent = 'Reconnecting…';
  chrome.runtime.sendMessage({ type: 'heal_content' }, (resp) => {
    healBtn.textContent = 'Reconnect page bridge';
    healBtn.disabled = false;
    if (!resp || !resp.ok) errorMsg.textContent = 'Could not reach the ChatGPT page — try refreshing that tab.';
    refresh();
  });
});

refresh();
setInterval(refresh, 2000);
