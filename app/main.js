const { app, BrowserWindow, ipcMain, dialog, shell, session, webContents, nativeImage, nativeTheme } = require('electron');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, exec, execFile, execFileSync } = require('child_process');
const http = require('http');
const { execAgentActions } = require('./lib/agentExecutor');
const { createDeliveryTracker } = require('./lib/deliveryTracker');
const { acceptsResponseSource } = require('./lib/transportPolicy');
const { installAppReloadShortcut } = require('./lib/appReload');
const { createAppUpdater } = require('./lib/appUpdater');
const { resolveVariant, iconFileFor, normalizePreference } = require('./lib/dockIcon');
const { autoUpdater } = require('electron-updater');

// macOS app names for the "Open in…" editor picker, and a reverse map from
// LaunchServices bundle ids used to detect the user's default handler.
const EDITOR_APPS = {
  vscode: 'Visual Studio Code',
  cursor: 'Cursor',
  zed: 'Zed',
  idea: 'IntelliJ IDEA',
};
const EDITOR_CLIS = { vscode: 'code', cursor: 'cursor', zed: 'zed', idea: 'idea' };
const BUNDLE_TO_EDITOR = {
  'com.microsoft.vscode': 'vscode',
  'com.todesktop.230313mzl4w4u92': 'cursor',
  'dev.zed.zed': 'zed',
  'com.jetbrains.intellij': 'idea',
  'com.jetbrains.intellij.ce': 'idea',
};

function installedEditors() {
  const dirs = ['/Applications', path.join(os.homedir(), 'Applications')];
  return Object.keys(EDITOR_APPS).filter((id) =>
    dirs.some((d) => fs.existsSync(path.join(d, EDITOR_APPS[id] + '.app'))),
  );
}

// Best-effort: which app macOS uses to open a `.py` file (public.python-script),
// mapped back to one of our editor ids. Falls back to the first installed editor.
function defaultEditorForPython() {
  try {
    const plist = path.join(
      os.homedir(),
      'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist',
    );
    if (fs.existsSync(plist)) {
      const json = execFileSync('plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' });
      const handlers = (JSON.parse(json) || {}).LSHandlers || [];
      const py = handlers.find(
        (h) => h && h.LSHandlerContentType === 'public.python-script' && h.LSHandlerRoleAll,
      );
      if (py) {
        const id = BUNDLE_TO_EDITOR[String(py.LSHandlerRoleAll).toLowerCase()];
        if (id) return id;
      }
    }
  } catch {}
  return installedEditors()[0] || null;
}

const WS_PORT = 8765;
const RENDERER_DIR = __dirname;
const NEXT_DEV_PORT = 3000;
const APP_URL = `http://localhost:${NEXT_DEV_PORT}/`;

function dataFile() {
  return path.join(app.getPath('userData'), 'conversations.json');
}

let mainWindow = null;
let wss = null;
let chatGPTClient = null;
let nextProcess = null;
let appUpdater = null;
let pageReady = false;
let serverListening = false;
const previewRecordings = new Map();
// Last ready URL per desktop conversation. A single global URL is invalid now that
// every conversation owns a different tab: whichever tab reconnected last used to
// overwrite the active desktop thread's saved link.
const lastReadyUrls = new Map();
// Clean user text is held until the ChatGPT page confirms that it actually clicked
// Submit. The browser receives the wire prompt; the desktop transcript receives
// this clean form only after the `sent` acknowledgement.
const pendingUserSends = createDeliveryTracker();
const transportTotals = {
  turns: 0,
  networkCompleted: 0,
  networkFailures: 0,
  domFallbacks: 0,
};

let pendingMessages = [];

// ── Unified debug log ───────────────────────────────────────────────────────
// The pipeline spans four JS contexts (renderer, main, extension background, and
// the ChatGPT page). To debug "ChatGPT responded but nothing showed up" you need
// to see ALL of them in order — so every context funnels its events through main
// and they print to THIS terminal, always on. The renderer relays over the
// `parallax-log` IPC; the content script relays over the WebSocket (`type:"log"`).
// One stream, whole flow, no DevTools spelunking across three consoles.
//
// The same stream is TEE'D TO A FILE (~/Library/Logs/Parallax/parallax.log). A terminal
// scrollback dies with the terminal, so "it broke a minute ago" had no evidence
// left to read. The file survives restarts, is truncated at each launch so it only
// ever holds the current session, and is the first thing to open when a turn
// misbehaves.
const LOG_DIR = path.join(os.homedir(), 'Library', 'Logs', 'Parallax');
const LOG_FILE = path.join(LOG_DIR, 'parallax.log');
let logStream = null;
function openLogFile() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    logStream = fs.createWriteStream(LOG_FILE, { flags: 'w' });
    logStream.on('error', () => { logStream = null; });
    logStream.write(`# Parallax session started ${new Date().toISOString()}\n`);
  } catch (_) {
    logStream = null;
  }
}
function wlog(scope, msg, extra) {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const line = `[parallax ${ts}] ${scope.padEnd(8)} ${msg}`;
  if (extra !== undefined) console.log(line, extra);
  else console.log(line);
  if (logStream) {
    try {
      logStream.write(extra !== undefined ? `${line} ${safeJson(extra)}\n` : `${line}\n`);
    } catch (_) {}
  }
}

function recordTransportMetric(metric) {
  transportTotals.turns++;
  if (metric.status === 'completed') transportTotals.networkCompleted++;
  else transportTotals.networkFailures++;
  transportTotals.domFallbacks += Number(metric.domFallbacks || 0);
  const fallbackRate = transportTotals.turns
    ? ((transportTotals.domFallbacks / transportTotals.turns) * 100).toFixed(2)
    : '0.00';
  wlog(
    'transport',
    `turns=${transportTotals.turns} network=${transportTotals.networkCompleted} ` +
    `failures=${transportTotals.networkFailures} dom=${transportTotals.domFallbacks} ` +
    `dom-rate=${fallbackRate}% current=${metric.status || 'unknown'} ` +
    `chars=${Number(metric.chars || 0)} first-text=${metric.firstTextMs ?? '-'}ms ` +
    `duration=${metric.durationMs ?? '-'}ms transports=${(metric.transports || []).join('+') || '-'}`,
  );
}
function safeJson(v) {
  try { return typeof v === 'string' ? v : JSON.stringify(v); } catch (_) { return String(v); }
}
// Compact preview of a possibly-large string for log lines.
function preview(s, n = 60) {
  if (!s) return '∅';
  const one = String(s).replace(/\s+/g, ' ').trim();
  return `len=${String(s).length} "${one.slice(0, n)}${one.length > n ? '…' : ''}"`;
}

// One-shot: is something already serving the dev port?
function probeNextDev() {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${NEXT_DEV_PORT}`, (res) => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.setTimeout(800, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// Kill the dev server AND its whole process group (only if WE spawned it).
function killNext() {
  if (!nextProcess) return;
  const proc = nextProcess;
  nextProcess = null;
  try { process.kill(-proc.pid, 'SIGTERM'); } // negative pid = the process group
  catch (_) { try { proc.kill('SIGTERM'); } catch (_) {} }
}

function waitForNextDev(maxAttempts = 60) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      attempts++;
      const req = http.get(`http://localhost:${NEXT_DEV_PORT}`, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (attempts >= maxAttempts) reject(new Error('Next.js dev server did not start'));
        else setTimeout(check, 1000);
      });
      req.end();
    };
    check();
  });
}

function createWindow() {
  pageReady = false;
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 500,
    minHeight: 400,
    titleBarStyle: 'hidden',
    // Center the macOS traffic lights within the 52px workspace topbar
    // (--workspace-topbar-height). Ignored on non-macOS platforms.
    trafficLightPosition: { x: 19, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Enables the <webview> element that powers the Browser preview surface
      // (same approach t3code uses for its hosted preview).
      webviewTag: true,
    },
  });

  const rendererUrl = app.isPackaged
    ? require('url').pathToFileURL(path.join(RENDERER_DIR, 'out', 'index.html')).toString()
    : APP_URL;

  // Electron's default reload follows the renderer's current URL. If that URL
  // ever drifts to a non-root path, Next correctly serves its 404 page and every
  // later reload stays there. Keep the app shortcut anchored to the shell root.
  installAppReloadShortcut(mainWindow.webContents, rendererUrl, () => {
    pageReady = false;
    wlog('main', 'reload shortcut → app shell');
  });

  // Harden every embedded <webview>. The preview loads the user's dev server and
  // arbitrary URLs, so it must never inherit our preload, Node, or app session.
  mainWindow.webContents.on('will-attach-webview', (_event, webPreferences, params) => {
    // Every preview receives the same trusted, sandboxed preload. Page code cannot
    // replace it; it only supplies the annotation overlay and guest-to-host events
    // used by the preview controls.
    webPreferences.preload = path.join(__dirname, 'preview-preload.js');
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    // Keep preview cookies/storage in their own partition, away from the app's.
    if (typeof params.partition !== 'string' || !params.partition.startsWith('persist:parallax-preview')) {
      params.partition = 'persist:parallax-preview';
    }
  });

  if (app.isPackaged) {
    mainWindow.loadURL(rendererUrl);
    return;
  }

  // Start (or reuse) the Next.js dev server, then load it.
  (async () => {
    try {
      // Reuse a dev server already listening on the port (e.g. a prior `pnpm run
      // dev` you didn't stop) instead of spawning a second one that crashes with
      // EADDRINUSE and leaves the app loading a half-started duplicate.
      const alreadyUp = await probeNextDev();
      if (alreadyUp) {
        console.log(`[next] reusing dev server already on :${NEXT_DEV_PORT}`);
      } else {
        // detached:true → its own process group, so killNext() can take down the
        // WHOLE tree (pnpm → node → next-server). Killing just the parent orphans
        // next-server and wedges the port — that's the recurring EADDRINUSE.
        nextProcess = spawn('pnpm', ['exec', 'next', 'dev', '-p', String(NEXT_DEV_PORT)], {
          cwd: RENDERER_DIR,
          stdio: 'pipe',
          detached: true,
        });
        nextProcess.stdout.on('data', (d) => process.stdout.write(`[next] ${d}`));
        nextProcess.stderr.on('data', (d) => process.stderr.write(`[next] ${d}`));
        nextProcess.on('exit', (code) => {
          if (code !== 0 && code !== null) console.error(`[next] exited with code ${code}`);
        });
        await waitForNextDev();
      }
      mainWindow.loadURL(APP_URL);
    } catch (err) {
      console.error('Failed to start Next.js dev server:', err);
      dialog.showErrorBox('Startup Error', `Failed to start Next.js dev server.\n\nMake sure dependencies are installed (pnpm install).\n\n${err.message}`);
    }
  })();

  mainWindow.webContents.on('did-finish-load', () => {
    // do nothing — pageReady is set by renderer's parallax-ready signal
  });
}

function sendToRenderer(channel, data) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!pageReady || !mainWindow.webContents || mainWindow.webContents.isLoading()) {
    pendingMessages.push([channel, data]);
    return;
  }
  mainWindow.webContents.send(channel, data);
}

function startWebSocketServer() {
  wss = new WebSocketServer({ port: WS_PORT });

  wss.on('listening', () => {
    serverListening = true;
    sendToRenderer('status', { type: 'server', status: 'listening', port: WS_PORT });
  });

  wss.on('error', (err) => {
    serverListening = false;
    wlog('ws', `server ERROR: ${err?.message || err}`);
    sendToRenderer('status', { type: 'server', status: 'error', message: err.message });
  });

  wss.on('connection', (ws) => {
    chatGPTClient = ws;
    wlog('ws', 'extension CONNECTED');
    sendToRenderer('status', { type: 'ws', status: 'connected' });

    // Keepalive ping every 10s to prevent MV3 service worker termination
    const keepalive = setInterval(() => {
      try { ws.send(JSON.stringify({ type: 'ping' })); } catch (_) { clearInterval(keepalive); }
    }, 10000);
    ws._keepalive = keepalive;

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        // The content script relays its own trace over the socket — print it as if
        // it were local, so the terminal shows the ChatGPT-page side of the flow.
        if (msg.type === 'log') { wlog('content', msg.msg, msg.extra); return; }
        if (msg.type !== 'pong') wlog('ws←ext', `${msg.type}${msg.msgId ? ` msgId=${msg.msgId}` : ''}`);

        switch (msg.type) {
          case 'transport_metric':
            recordTransportMetric(msg);
            break;
          case 'response':
            if (!acceptsResponseSource(msg.source)) {
              transportTotals.domFallbacks++;
              wlog(
                'transport',
                `REJECTED non-network response source=${msg.source || 'unspecified'} ` +
                `dom=${transportTotals.domFallbacks}`,
              );
              sendToRenderer('error', {
                source: msg.source || 'non-network',
                message: 'Rejected a response that did not come from the network stream.',
                msgId: msg.msgId || '',
                url: msg.url || '',
                convId: msg.convId || '',
              });
              break;
            }
            wlog('ws←ext', `response ${preview(msg.text)} url=${msg.url || '-'}`);
            sendToRenderer('response', {
              source: msg.source || '',
              text: msg.text || '',
              toolCalls: msg.toolCalls || '',
              msgId: msg.msgId || '',
              url: msg.url || '',
              convId: msg.convId || '',
            });
            break;
          case 'stream_update':
            sendToRenderer('stream_update', {
              text: msg.text || '',
              msgId: msg.msgId || '',
              convId: msg.convId || '',
            });
            break;
          case 'sent': {
            const delivery = pendingUserSends.acknowledge(msg.msgId, msg.convId);
            if (delivery) sendToRenderer('sent', delivery);
            break;
          }
          case 'error':
            wlog('ws←ext', `error "${msg.message}" url=${msg.url || '-'}`);
            pendingUserSends.fail(msg.msgId);
            sendToRenderer('error', {
              source: msg.source || '',
              message: msg.message,
              msgId: msg.msgId,
              url: msg.url || '',
              convId: msg.convId || '',
            });
            break;
          case 'ready':
            wlog('ws←ext', `ready url=${msg.url || '-'}`);
            if (msg.convId && msg.url) lastReadyUrls.set(msg.convId, msg.url);
            sendToRenderer('status', {
              type: 'chatgpt',
              status: 'ready',
              url: msg.url,
              convId: msg.convId || '',
            });
            break;
          // The ChatGPT tab navigated within the SPA (no reload). Correct where the
          // desktop thinks the tab is WITHOUT re-binding the thread's saved chat.
          // The page refused to send because the tab isn't on that thread's chat.
          // The renderer navigates to the stored link and replays the message.
          case 'wrong_conversation':
            wlog('ws←ext', `wrong_conversation — tab on ${msg.actual || '-'}, expected ${msg.expected || '-'}`);
            sendToRenderer('wrong_conversation', {
              expected: msg.expected,
              actual: msg.actual,
              msgId: msg.msgId,
              convId: msg.convId || '',
            });
            break;
          case 'tab_url':
            wlog('ws←ext', `tab_url → ${msg.url || '-'}`);
            sendToRenderer('status', {
              type: 'chatgpt',
              status: 'tab_url',
              url: msg.url,
              convId: msg.convId || '',
            });
            break;
          case 'debug_result':
            sendToRenderer('debug_result', { action: msg.action, data: msg.data });
            break;
          case 'models': {
            const mModels = Array.isArray(msg.models) ? msg.models : [];
            const mIntel = Array.isArray(msg.intelligences) ? msg.intelligences : [];
            const mCurrent = typeof msg.currentModel === 'string' ? msg.currentModel : '';
            const mCurrentIntel = typeof msg.currentIntelligence === 'string' ? msg.currentIntelligence : '';
            // Prints to THIS terminal so the whole path is visible without DevTools:
            // if `intel` is empty here, the extension isn't sending tiers.
            console.log(`[parallax] models: conv=${msg.convId || '-'} | ${mModels.length} models | current=${mCurrent || '-'} | selected-intel=${mCurrentIntel || '-'} | intel=${mIntel.map((i) => i && i.label).filter(Boolean).join(',') || '-'}`);
            // Forward the DOM-scraped Intelligence tiers + current model too — the
            // renderer accumulates per-model intelligence from these.
            sendToRenderer('models', {
              convId: msg.convId || '',
              models: mModels,
              intelligences: mIntel,
              currentModel: mCurrent,
              currentIntelligence: mCurrentIntel,
            });
            break;
          }
          case 'selection_error': {
            wlog('ws←ext', `selection_error conv=${msg.convId || '-'} ${msg.message || 'unknown error'}`);
            sendToRenderer('selection_error', {
              convId: msg.convId || '',
              message: msg.message || 'Could not apply the selected model or intelligence.',
              currentModel: msg.currentModel || '',
              currentIntelligence: msg.currentIntelligence || '',
            });
            break;
          }
          case 'new_chat_started':
            sendToRenderer('status', {
              type: 'chatgpt',
              status: 'navigating',
              convId: msg.convId || '',
            });
            break;
          case 'navigating':
            sendToRenderer('status', {
              type: 'chatgpt',
              status: 'navigating',
              url: msg.url,
              convId: msg.convId || '',
            });
            break;
        }
      } catch (err) {
        console.error('[wss] parse error:', err);
      }
    });

    ws.on('close', () => {
      clearInterval(ws._keepalive);
      // A replacement socket may already be active by the time an older socket's
      // close callback runs. Never let that stale callback clear the live client.
      if (chatGPTClient !== ws) return;
      chatGPTClient = null;
      wlog('ws', 'extension DISCONNECTED (close)');
      sendToRenderer('status', { type: 'ws', status: 'disconnected' });
    });

    ws.on('error', (err) => {
      clearInterval(ws._keepalive);
      if (chatGPTClient !== ws) return;
      chatGPTClient = null;
      wlog('ws', `extension DISCONNECTED (error: ${err?.message || err})`);
      sendToRenderer('status', { type: 'ws', status: 'disconnected' });
    });
  });
}

// Dev only: watch the extension source and tell the extension to reload ITSELF.
// Iterating on the extension shouldn't cost a manual "reload extension, refresh the
// ChatGPT tab" every single time — that treadmill is on us, not the user.
function watchExtensionForReload() {
  if (!process.argv.includes('--dev')) return;
  const extDir = path.join(__dirname, '..', 'ext');
  if (!fs.existsSync(extDir)) return;
  let timer = null;
  try {
    fs.watch(extDir, { recursive: true }, (_evt, file) => {
      if (file && !/\.(js|json|html)$/.test(String(file))) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (sendToExtension({ type: 'reload_extension' })) {
          wlog('dev', `extension source changed (${file}) → reloading the extension`);
        }
      }, 500); // debounce: editors fire several events per save
    });
    wlog('dev', `watching ${extDir} — the extension now reloads itself on change`);
  } catch (e) {
    wlog('dev', `extension watch unavailable: ${e.message}`);
  }
}

function sendToExtension(msg) {
  if (chatGPTClient) {
    chatGPTClient.send(JSON.stringify(msg));
    if (msg.type !== 'ping') wlog('main→ext', msg.type + (msg.msgId ? ` msgId=${msg.msgId}` : ''));
    return true;
  }
  wlog('main→ext', `${msg.type} DROPPED — no extension connected`);
  return false;
}

// Renderer relays its own pipeline trace here so it prints in the same terminal
// stream as the main/extension/content events — always on, no DevTools needed.
// Dock icon. The packaged .icns is fixed, but the dock tile can be swapped at
// runtime so Settings can offer a light or dark plate. macOS only: app.dock is
// undefined elsewhere.
let dockIconPreference = 'system';

function applyDockIcon(preference = dockIconPreference) {
  dockIconPreference = normalizePreference(preference);
  if (!app.dock) return dockIconPreference;
  const variant = resolveVariant(dockIconPreference, nativeTheme.shouldUseDarkColors);
  const file = path.join(__dirname, 'build', iconFileFor(variant));
  try {
    const image = nativeImage.createFromPath(file);
    if (!image.isEmpty()) app.dock.setIcon(image);
  } catch (error) {
    wlog('main', `dock icon failed: ${error.message}`);
  }
  return dockIconPreference;
}

ipcMain.handle('set-dock-icon', (_event, preference) => applyDockIcon(preference));

ipcMain.on('parallax-log', (_event, { scope, msg, extra }) => wlog(scope || 'renderer', msg, extra));

ipcMain.on('send-message', (_event, { text, model, intelligence, wireText, silent, expectUrl, convId, msgId: requestedMsgId }) => {
  const msgId = requestedMsgId || `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  // `wireText` (preamble + task, or fed-back tool results) is what ChatGPT actually
  // receives; `text` is the clean user message echoed back for display. `silent`
  // turns are agent tool-result follow-ups — sent to ChatGPT but not shown in the UI.
  const outgoing = wireText || text;
  wlog('ipc', `send-message ${silent ? '(silent) ' : ''}${preview(outgoing)} model=${model || '-'} intel=${intelligence || '-'}`);
  if (!silent) pendingUserSends.remember(msgId, text, convId);
  if (!sendToExtension({ type: 'send_message', text: outgoing, msgId, model, intelligence, expectUrl, convId })) {
    pendingUserSends.fail(msgId);
    sendToRenderer('error', {
      convId,
      msgId,
      message: 'No Chrome extension connected. Open ChatGPT and check the Parallax popup.',
    });
    return;
  }
});

ipcMain.on('edit-message', (_event, payload) => {
  const {
    text,
    wireText,
    expectUrl,
    convId,
    originalText,
    userIndex,
    msgId: requestedMsgId,
  } = payload || {};
  const msgId = requestedMsgId || `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const outgoing = wireText || text;
  wlog('ipc', `edit-message ${preview(outgoing)} userIndex=${userIndex} conv=${convId || '-'}`);
  pendingUserSends.remember(msgId, text, convId);
  if (!sendToExtension({
    type: 'edit_message',
    text: outgoing,
    msgId,
    expectUrl,
    convId,
    originalText,
    userIndex,
  })) {
    pendingUserSends.fail(msgId);
    sendToRenderer('error', {
      convId,
      msgId,
      message: 'No Chrome extension connected. Open ChatGPT and check the Parallax popup.',
    });
  }
});

// Picking a model/intelligence in the app switches it on that conversation's
// dedicated ChatGPT tab right away.
ipcMain.on('switch-model', (_event, { model, intelligence, convId }) => {
  sendToExtension({ type: 'switch_model', model, intelligence, convId });
});

ipcMain.on('send-files', (_event, { convId, files }) => {
  if (!sendToExtension({ type: 'send_files', convId, files })) {
    sendToRenderer('error', { convId, message: 'No extension connected — cannot upload files.' });
  }
});

ipcMain.on('debug-dom', () => {
  if (!sendToExtension({ type: 'debug', action: 'dom' })) {
    sendToRenderer('error', { message: 'No extension connected — cannot debug DOM.' });
  }
});

ipcMain.on('new-chat', (_event, payload) => {
  if (!sendToExtension({ type: 'new_chat', convId: payload && payload.convId })) {
    sendToRenderer('error', {
      convId: payload && payload.convId,
      message: 'No extension connected — cannot start new chat.',
    });
  }
});

ipcMain.on('navigate', (_event, payload) => {
  const url = typeof payload === 'string' ? payload : payload && payload.url;
  if (!sendToExtension({ type: 'navigate', url, convId: payload && payload.convId })) {
    sendToRenderer('error', {
      convId: payload && payload.convId,
      message: 'No extension connected — cannot navigate.',
    });
  }
});

ipcMain.on('parallax-ready', () => {
  pageReady = true;
  const batch = pendingMessages;
  pendingMessages = [];
  for (const [ch, data] of batch) {
    mainWindow.webContents.send(ch, data);
  }
  // Re-sync the renderer to the CURRENT link state. A renderer that just (re)loaded
  // reset its status to "waiting"; the WS `connection` event that would set it to
  // "connected" already fired and won't repeat. Without this snapshot the app shows
  // "Extension not connected" and queues sends even though the extension is live.
  const connected = !!chatGPTClient;
  wlog('ipc', `parallax-ready → status snapshot: ws=${connected ? 'connected' : 'disconnected'} chats=${lastReadyUrls.size}`);
  sendToRenderer('status', {
    type: 'server',
    status: serverListening ? 'listening' : 'error',
    port: WS_PORT,
  });
  sendToRenderer('status', { type: 'ws', status: connected ? 'connected' : 'disconnected' });
  if (connected) {
    for (const [convId, url] of lastReadyUrls) {
      sendToRenderer('status', { type: 'chatgpt', status: 'ready', url, convId });
    }
  }
  if (appUpdater) sendToRenderer('app-update-status', appUpdater.getState());
});

ipcMain.handle('app-update-status', () => (
  appUpdater
    ? appUpdater.getState()
    : {
        status: app.isPackaged ? 'idle' : 'disabled',
        currentVersion: app.getVersion(),
        availableVersion: '',
        progress: null,
        message: app.isPackaged
          ? 'Parallax checks for updates automatically.'
          : 'Update checks are available in installed builds.',
      }
));

ipcMain.handle('app-update-check', () => (
  appUpdater ? appUpdater.check() : null
));

ipcMain.on('app-update-install', () => {
  appUpdater?.install();
});

ipcMain.handle('save-data', (_event, data) => {
  try {
    fs.writeFileSync(dataFile(), JSON.stringify(data, null, 2));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('load-data', () => {
  try {
    if (fs.existsSync(dataFile())) {
      const raw = fs.readFileSync(dataFile(), 'utf8');
      return { ok: true, data: JSON.parse(raw) };
    }
    return { ok: true, data: null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false };
  }
  return { ok: true, path: result.filePaths[0] };
});

// ── Workspace tool executor ─────────────────────────────────────────────────
ipcMain.handle('agent-exec', async (event, { cwd, actions, executionId }) => {
  const sender = event.sender;
  const results = await execAgentActions(cwd, actions, (actionIndex, progress) => {
    if (!executionId || sender.isDestroyed()) return;
    sender.send('agent_exec_progress', {
      executionId,
      actionIndex,
      status: progress.status,
      content: progress.content,
    });
  });
  return { results };
});

// ── Open in editor / editor detection ───────────────────────────────────────
ipcMain.on('open-in-editor', (_event, { editorId, cwd }) => {
  if (!cwd) return;
  if (editorId === 'file-manager') {
    shell.openPath(cwd);
    return;
  }
  const appName = EDITOR_APPS[editorId];
  if (process.platform === 'darwin' && appName) {
    // `open -a` uses LaunchServices, so it works even when the editor's CLI
    // isn't on the (minimal) PATH a Finder-launched Electron app inherits.
    execFile('open', ['-a', appName, cwd], (err) => {
      if (!err) return;
      const cli = EDITOR_CLIS[editorId];
      if (cli) {
        exec(`${cli} "${String(cwd).replace(/"/g, '\\"')}"`, (e2) => {
          if (e2) shell.openPath(cwd);
        });
      } else {
        shell.openPath(cwd);
      }
    });
  } else {
    shell.openPath(cwd);
  }
});

ipcMain.handle('detect-editors', async () => {
  if (process.platform !== 'darwin') {
    return { available: Object.keys(EDITOR_APPS), default: null };
  }
  return { available: installedEditors(), default: defaultEditorForPython() };
});

// ── Embedded browser controls ───────────────────────────────────────────────
ipcMain.handle('preview-open-external', async (_event, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return { ok: false, error: 'Only HTTP and HTTPS preview URLs can be opened.' };
  }
  await shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle('preview-clear-cookies', async () => {
  await session.fromPartition('persist:parallax-preview').clearStorageData({ storages: ['cookies'] });
  return { ok: true };
});

ipcMain.handle('preview-clear-cache', async () => {
  await session.fromPartition('persist:parallax-preview').clearCache();
  return { ok: true };
});

ipcMain.handle('preview-list-servers', async () => {
  const stdout = await new Promise((resolve) => {
    execFile('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'], { encoding: 'utf8' }, (error, output) => {
      resolve(error ? '' : output || '');
    });
  });
  const servers = new Map();
  let pid = null;
  let command = null;
  for (const line of String(stdout).split(/\r?\n/)) {
    const tag = line[0];
    const value = line.slice(1).trim();
    if (tag === 'p') {
      pid = Number(value) || null;
      command = null;
      continue;
    }
    if (tag === 'c') {
      command = value || null;
      continue;
    }
    if (tag !== 'n') continue;
    const colon = value.lastIndexOf(':');
    if (colon < 0) continue;
    const host = value.slice(0, colon);
    if (!['*', '127.0.0.1', 'localhost', '[::]', '[::1]'].includes(host)) continue;
    const port = Number(value.slice(colon + 1).split(/\s+/, 1)[0]);
    if (!Number.isInteger(port) || port <= 0 || port === WS_PORT || port === NEXT_DEV_PORT) continue;
    if (!servers.has(port)) {
      servers.set(port, {
        port,
        command: command || 'server',
        pid,
        url: `http://localhost:${port}`,
      });
    }
  }
  return [...servers.values()].sort((a, b) => a.port - b.port);
});

ipcMain.handle('preview-recording-start', async (event, payload) => {
  const id = Number(payload && payload.webContentsId);
  const target = webContents.fromId(id);
  if (!target || target.isDestroyed()) throw new Error('Preview is not available.');
  if (previewRecordings.has(id)) return { ok: true };
  if (target.debugger.isAttached()) {
    throw new Error('Close the preview DevTools before starting a recording.');
  }
  target.debugger.attach('1.3');
  const sender = event.sender;
  const onMessage = (_debugEvent, method, params) => {
    if (method !== 'Page.screencastFrame') return;
    if (!sender.isDestroyed()) {
      sender.send('preview-recording-frame', {
        webContentsId: id,
        data: params.data,
        metadata: params.metadata || {},
      });
    }
    target.debugger
      .sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId })
      .catch(() => {});
  };
  const cleanup = () => {
    const active = previewRecordings.get(id);
    if (!active) return;
    target.debugger.removeListener('message', active.onMessage);
    previewRecordings.delete(id);
  };
  target.debugger.on('message', onMessage);
  target.debugger.once('detach', cleanup);
  previewRecordings.set(id, { target, onMessage, cleanup });
  try {
    await target.debugger.sendCommand('Page.enable');
    await target.debugger.sendCommand('Page.startScreencast', {
      format: 'jpeg',
      quality: 82,
      maxWidth: 1600,
      maxHeight: 1200,
      everyNthFrame: 1,
    });
    return { ok: true };
  } catch (error) {
    cleanup();
    if (target.debugger.isAttached()) target.debugger.detach();
    throw error;
  }
});

ipcMain.handle('preview-recording-stop', async (_event, payload) => {
  const id = Number(payload && payload.webContentsId);
  const active = previewRecordings.get(id);
  if (!active) return { ok: true };
  try {
    await active.target.debugger.sendCommand('Page.stopScreencast');
  } catch {}
  active.cleanup();
  if (active.target.debugger.isAttached()) active.target.debugger.detach();
  return { ok: true };
});

ipcMain.handle('preview-save-recording', async (_event, payload) => {
  const mime = typeof payload?.mime === 'string' ? payload.mime : 'video/webm';
  const extension = mime.includes('mp4') ? 'mp4' : 'webm';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const result = await dialog.showSaveDialog({
    title: 'Save browser recording',
    defaultPath: path.join(app.getPath('downloads'), `parallax-browser-${stamp}.${extension}`),
    filters: [{ name: 'Browser recording', extensions: [extension] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  fs.writeFileSync(result.filePath, Buffer.from(payload.data));
  return { ok: true, path: result.filePath };
});

// Ask the extension to stop the in-flight generation (best effort). The convId
// aims it at that thread's own tab — without it the background had to guess, and a
// guess that found nothing surfaced a "no content script" error for an action that
// had already taken effect locally.
ipcMain.on('stop-generating', (_e, convId) => {
  wlog('renderer', `stop-generating conv=${convId || '-'}`);
  sendToExtension({ type: 'stop', convId: convId || '' });
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  dialog.showErrorBox('Unexpected Error', err.message || String(err));
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  dialog.showErrorBox('Unexpected Error', err?.message || String(err));
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  nativeTheme.on('updated', () => {
    if (dockIconPreference === 'system') applyDockIcon();
  });

  app.whenReady().then(() => {
    openLogFile();
    wlog('main', `log file → ${LOG_FILE}`);
    createWindow();
    startWebSocketServer();
    watchExtensionForReload();
    appUpdater = createAppUpdater({
      app,
      autoUpdater,
      send: (status) => sendToRenderer('app-update-status', status),
      logger: {
        info: (message) => wlog('updater', message),
        warn: (message) => wlog('updater', message),
        error: (message) => wlog('updater', message),
        debug: (message) => wlog('updater', message),
      },
    });
    appUpdater.start();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  killNext();
  if (wss) wss.close();
  if (process.platform !== 'darwin') app.quit();
});

// Make sure the dev server dies on every exit path (⌘Q, crash, Ctrl-C), so it
// can't orphan and hold the port.
app.on('before-quit', killNext);
app.on('will-quit', () => {
  appUpdater?.dispose();
  killNext();
});
process.on('exit', killNext);
process.on('SIGINT', () => { killNext(); process.exit(0); });
process.on('SIGTERM', () => { killNext(); process.exit(0); });
