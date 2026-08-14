if (typeof importScripts === 'function') importScripts('build-config.js');

const DEFAULT_WS_URL = 'ws://localhost:8765';
const CHATGPT_URLS = ['https://chatgpt.com/*', 'https://chat.openai.com/*'];
const PARALLAX_DEBUG = globalThis.__parallaxBuildConfig?.debug === true;
const debugLog = PARALLAX_DEBUG
  ? console.log.bind(console, '[Parallax][bg]')
  : () => {};

let ws = null;
let contentPort = null;
let contentTabId = null;
let reconnectTimer = null;
let reconnectCount = 0;
let wsUrl = DEFAULT_WS_URL;
let bridgeEnabled = false;
const deliveryTasks = new Map(); // one ordered command stream per conversation
const activeTurns = new Map(); // accepted page turns awaiting a terminal reply
const stagedFilesByConversation = new Map(); // held locally until the matching send
let folderProjects = {}; // absolute desktop folder → { name, url }
const folderProjectTasks = new Map(); // one create/lookup operation per folder
const projectSetupWaiters = new Map(); // request id → { tabId, projectName, finish }
const ACTIVE_TURN_MAX_AGE_MS = 10 * 60 * 1000;

function persistedActiveTurns() {
  return Object.fromEntries([...activeTurns.entries()].map(([convId, turn]) => [
    convId,
    {
      ...turn,
      files: [],
      attachmentsLost: Boolean(turn.attachmentsLost || turn.files?.length),
    },
  ]));
}

function persistActiveTurns() {
  chrome.storage.local.set({ parallax_active_turns: persistedActiveTurns() });
}

function sendTurnStatus() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify({
      type: 'turn_status',
      turns: [...activeTurns.values()].map((turn) => ({
        convId: turn.convId,
        msgId: turn.msgId,
        accepted: Boolean(turn.accepted),
      })),
    }));
  } catch (_) {}
}

function stageFiles(convId, files) {
  if (!convId || !Array.isArray(files) || !files.length) return 0;
  stagedFilesByConversation.set(convId, [...files]);
  return files.length;
}

function takeStagedFiles(convId) {
  const files = stagedFilesByConversation.get(convId) || [];
  stagedFilesByConversation.delete(convId);
  return files;
}

function canonicalProjectUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  try {
    const url = new URL(rawUrl);
    if (!['chatgpt.com', 'chat.openai.com'].includes(url.hostname)) return null;
    const match = /^\/g\/(g-p-[^/?#]+)\/project(?:\/|$)/.exec(url.pathname);
    if (!match) return null;
    return `https://chatgpt.com/g/${encodeURIComponent(match[1])}/project`;
  } catch (_) {
    return null;
  }
}

function persistFolderProjects() {
  chrome.storage.local.set({ parallax_folder_projects: folderProjects });
}

function mapFolderProject(projectKey, projectName, rawUrl) {
  const url = canonicalProjectUrl(rawUrl);
  if (!projectKey || !projectName || !url) return null;
  folderProjects[projectKey] = { name: projectName, url };
  persistFolderProjects();
  return folderProjects[projectKey];
}

function rememberTurn(convId, tabId, msg, msgId, files = []) {
  if (!convId || !msgId) return;
  activeTurns.set(convId, {
    convId,
    tabId,
    msgId,
    text: msg.text || '',
    model: msg.model || '',
    intelligence: msg.intelligence || '',
    expectUrl: msg.expectUrl || '',
    files: Array.isArray(files) ? [...files] : [],
    attachmentsLost: false,
    updatedAt: Date.now(),
    accepted: false,
  });
  persistActiveTurns();
  sendTurnStatus();
}

function acceptTurn(convId, msgId) {
  const turn = activeTurns.get(convId);
  if (!turn || turn.msgId !== msgId) return false;
  turn.accepted = true;
  turn.updatedAt = Date.now();
  persistActiveTurns();
  sendTurnStatus();
  return true;
}

function settleTurn(convId, msgId) {
  const turn = activeTurns.get(convId);
  if (!turn || (msgId && turn.msgId !== msgId)) return false;
  activeTurns.delete(convId);
  persistActiveTurns();
  sendTurnStatus();
  return true;
}

function recoveryMessageForConversation(convId) {
  const turn = activeTurns.get(convId);
  if (!turn) return null;
  if (!turn.accepted) {
    return {
      type: 'resume_pending_turn',
      msgId: turn.msgId,
      text: turn.text,
      model: turn.model,
      intelligence: turn.intelligence,
      expectUrl: turn.expectUrl,
      files: turn.files,
      attachmentsLost: Boolean(turn.attachmentsLost),
    };
  }
  return {
    type: 'recover_turn',
    msgId: turn.msgId,
    text: turn.text,
    expectUrl: turn.expectUrl,
  };
}

// Relay a trace line to the desktop terminal (over the socket) AND the SW console.
// The background worker is a pass-through, so the one failure it can hide is
// "message for the page arrived but no content script was connected" — log that.
function bwlog(msg) {
  if (!PARALLAX_DEBUG) return;
  try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'log', msg: `[bg] ${msg}` })); } catch (_) {}
  debugLog(msg);
}

async function contentScriptPresent(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => globalThis.__parallaxContentLoaded === true,
    });
    return results.some((result) => result?.result === true);
  } catch (_) {
    return false;
  }
}

// Reloading the extension invalidates the content script's context on any already
// open ChatGPT tab: the old script keeps running but can never reconnect, so every
// message dies with "No content script connected" until the user manually refreshes.
// Re-inject on demand instead. Probe the isolated-world marker first — if a LIVE
// script is present it is already retrying its port, and injecting again would
// duplicate every window listener, timer, warning, and send path.
// Re-inject the content script into every conversation tab whose context died
// (an extension reload invalidates them; the old script keeps running but can
// never reconnect). Delivery already re-injects on demand — this is the manual
// "Reconnect page bridge" path from the popup.
async function ensureContentScript() {
  let healed = 0;
  for (const [convId, tabId] of Object.entries(convTabs)) {
    if (ports.get(tabId)) continue;
    if (!(await tabAlive(tabId))) { forgetTab(tabId); continue; }
    try {
      if (await contentScriptPresent(tabId)) {
        bwlog(`waiting for existing content script on tab ${tabId} (conv ${convId})`);
        if (await waitForPort(tabId, 5000)) healed++;
        continue;
      }
      bwlog(`re-injecting content script into tab ${tabId} (conv ${convId})`);
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['src/build-config.js', 'src/protocol-core.js', 'src/content.js'],
      });
      if (await waitForPort(tabId, 5000)) healed++;
    } catch (e) {
      bwlog(`re-inject failed for tab ${tabId}: ${e && e.message}`);
    }
  }
  bwlog(`page-bridge recovery: ${healed} tab(s) reconnected`);
  return healed > 0 || ports.size > 0;
}
// ONE DEDICATED TAB PER CONVERSATION.
//
// Parallax used to drive a single shared tab and navigate it between conversations.
// That reload was the source of most of the pain: it cost seconds on every chat
// switch, and any drift between "where the tab actually is" and "where we think it
// is" sent a message into the wrong chat. Giving each conversation its own tab
// removes the navigation entirely — the tab is ALREADY on its conversation, so
// sending is instant and cross-talk is impossible by construction.
//
// convId → tabId, persisted so a service-worker restart keeps the mapping.
let convTabs = {};
const tabConv = new Map();   // tabId → convId (derived)
const ports = new Map();     // tabId → port (one content script per owned tab)

// Resolves once the persisted mapping has loaded. Ownership decisions MUST wait for
// this: a service-worker restart races reconnecting tabs, and deciding early made us
// tell a legitimate tab to stand down forever ("No content script connected").
const storageReady = new Promise((resolve) => {
  try {
    chrome.storage.local.get([
      'parallax_conv_tabs',
      'parallax_folder_projects',
      'parallax_active_turns',
    ], (d) => {
      const stored = d && d.parallax_conv_tabs;
      if (stored && typeof stored === 'object') {
        // MERGE, never replace — a tab mapped between SW start and this callback
        // would otherwise be silently dropped and re-opened as a duplicate.
        for (const [c, t] of Object.entries(stored)) {
          if (convTabs[c] === undefined) {
            const previousOwner = tabConv.get(t);
            if (previousOwner && previousOwner !== c) delete convTabs[previousOwner];
            convTabs[c] = t;
            tabConv.set(t, c);
          }
        }
        persistConvTabs();
      }
      const storedProjects = d && d.parallax_folder_projects;
      if (storedProjects && typeof storedProjects === 'object') {
        for (const [projectKey, value] of Object.entries(storedProjects)) {
          const name = value && typeof value === 'object' ? value.name : '';
          const url = value && typeof value === 'object' ? value.url : value;
          const canonical = canonicalProjectUrl(url);
          if (projectKey && name && canonical) {
            folderProjects[projectKey] = { name, url: canonical };
          }
        }
        persistFolderProjects();
      }
      const storedTurns = d && d.parallax_active_turns;
      const oldestAllowed = Date.now() - ACTIVE_TURN_MAX_AGE_MS;
      if (storedTurns && typeof storedTurns === 'object') {
        for (const [convId, turn] of Object.entries(storedTurns)) {
          if (
            convId &&
            !activeTurns.has(convId) &&
            turn &&
            typeof turn === 'object' &&
            typeof turn.msgId === 'string' &&
            turn.msgId &&
            Number(turn.updatedAt) >= oldestAllowed
          ) {
            activeTurns.set(convId, {
              ...turn,
              convId,
              files: [],
              attachmentsLost: Boolean(turn.attachmentsLost),
            });
          }
        }
      }
      persistActiveTurns();
      resolve();
    });
  } catch (_) {
    resolve();
  }
});

function persistConvTabs() {
  chrome.storage.local.set({ parallax_conv_tabs: convTabs });
}

function mapConvTab(convId, tabId) {
  if (!convId || typeof tabId !== 'number') return;
  const prev = convTabs[convId];
  if (prev !== undefined && prev !== tabId) tabConv.delete(prev);
  const previousOwner = tabConv.get(tabId);
  if (previousOwner && previousOwner !== convId) delete convTabs[previousOwner];
  convTabs[convId] = tabId;
  tabConv.set(tabId, convId);
  persistConvTabs();
}

function forgetTab(tabId) {
  const convId = tabConv.get(tabId);
  tabConv.delete(tabId);
  ports.delete(tabId);
  if (convId && convTabs[convId] === tabId) {
    delete convTabs[convId];
    persistConvTabs();
  }
}

// Is this tab still alive and on ChatGPT?
async function tabAlive(tabId) {
  if (typeof tabId !== 'number') return false;
  try {
    const tab = await chrome.tabs.get(tabId);
    return Boolean(tab);
  } catch (_) {
    return false;
  }
}

// Resolve the INSTANT the tab's content script connects — driven by the onConnect
// event, not by polling every 100ms and hoping the guessed budget was enough.
const portWaiters = new Map(); // tabId → [resolve, …]
const pageProbeWaiters = new Map(); // probe id → { tabId, finish }

function notifyPortReady(tabId, port) {
  const waiters = portWaiters.get(tabId);
  if (!waiters) return;
  portWaiters.delete(tabId);
  for (const r of waiters) r(port);
}

function waitForPort(tabId, failsafeMs = 60000) {
  const existing = ports.get(tabId);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const list = portWaiters.get(tabId) || [];
    let settled = false;
    const once = (p) => { if (!settled) { settled = true; resolve(p); } };
    list.push(once);
    portWaiters.set(tabId, list);
    // Failsafe only — a tab that never loads must not block forever.
    setTimeout(() => once(ports.get(tabId) || null), failsafeMs);
  });
}

function probePagePort(tabId, port, failsafeMs = 2500) {
  if (!port) return Promise.resolve(false);
  const probeId = crypto.randomUUID();
  return new Promise((resolve) => {
    let timer = null;
    let settled = false;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      pageProbeWaiters.delete(probeId);
      resolve(Boolean(ready));
    };
    pageProbeWaiters.set(probeId, { tabId, finish });
    try {
      port.postMessage({ type: 'page_probe', probeId });
    } catch (_) {
      finish(false);
      return;
    }
    timer = setTimeout(() => finish(false), failsafeMs);
  });
}

function resolvePageProbe(tabId, probeId) {
  const waiter = pageProbeWaiters.get(probeId);
  if (!waiter || waiter.tabId !== tabId) return false;
  waiter.finish(true);
  return true;
}

function failPageProbes(tabId) {
  for (const waiter of pageProbeWaiters.values()) {
    if (waiter.tabId === tabId) waiter.finish(false);
  }
}

function resolveProjectSetup(tabId, msg) {
  const waiter = projectSetupWaiters.get(msg?.requestId);
  if (!waiter || waiter.tabId !== tabId) return false;
  if (msg.type === 'project_ready') {
    const url = canonicalProjectUrl(msg.url);
    waiter.finish(url ? { url } : { error: 'ChatGPT returned an invalid project link.' });
  } else if (msg.type === 'project_error') {
    waiter.finish({ error: msg.message || 'ChatGPT could not create the project.' });
  } else {
    return false;
  }
  return true;
}

function requestProjectSetup(tabId, port, projectName, failsafeMs = 60000) {
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    let timer = null;
    let settled = false;
    const onUpdated = (id, change, tab) => {
      if (id !== tabId) return;
      const url = canonicalProjectUrl(change?.url || tab?.url);
      if (url) finish({ url });
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      projectSetupWaiters.delete(requestId);
      try { chrome.tabs.onUpdated.removeListener(onUpdated); } catch (_) {}
      resolve(result);
    };
    projectSetupWaiters.set(requestId, { tabId, projectName, finish });
    chrome.tabs.onUpdated.addListener(onUpdated);
    timer = setTimeout(
      () => finish({ error: `Timed out creating ChatGPT project "${projectName}".` }),
      failsafeMs,
    );
    chrome.tabs.get(tabId).then((tab) => {
      const url = canonicalProjectUrl(tab?.url);
      if (url) finish({ url });
    }).catch(() => {});
    try {
      port.postMessage({ type: 'ensure_project', requestId, projectName });
    } catch (error) {
      finish({ error: error?.message || 'Could not ask ChatGPT to create the project.' });
    }
  });
}

function resumeProjectSetups(tabId, port) {
  for (const [requestId, waiter] of projectSetupWaiters) {
    if (waiter.tabId !== tabId) continue;
    try {
      port.postMessage({
        type: 'ensure_project',
        requestId,
        projectName: waiter.projectName,
      });
    } catch (_) {}
  }
}

// Same idea for page load: listen for the tab reaching "complete".
function waitForTabLoad(tabId, failsafeMs = 60000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      try { chrome.tabs.onUpdated.removeListener(onUpd); } catch (_) {}
      resolve(v);
    };
    const onUpd = (id, info) => {
      if (id === tabId && info.status === 'complete') finish(true);
    };
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.get(tabId).then((t) => {
      if (t && t.status === 'complete') finish(true);
    }).catch(() => finish(false));
    setTimeout(() => finish(false), failsafeMs);
  });
}

async function livePortForTab(tabId, created) {
  let port = ports.get(tabId);
  if (port && !(await probePagePort(tabId, port))) {
    bwlog(`page bridge on tab ${tabId} did not acknowledge — reconnecting`);
    ports.delete(tabId);
    if (contentPort === port) contentPort = null;
    port = null;
  }
  if (!port) {
    if (created) {
      bwlog(`waiting for tab ${tabId} to load ChatGPT…`);
      await waitForTabLoad(tabId);
    }
    port = await waitForPort(tabId, created ? 60000 : 1500);
    if (!port) {
      try {
        bwlog(`no live page bridge on tab ${tabId} — reloading task tab`);
        ports.delete(tabId);
        await chrome.tabs.reload(tabId);
        await waitForTabLoad(tabId, 30000);
        port = await waitForPort(tabId, 30000);
      } catch (error) {
        bwlog(`task-tab reload failed for ${tabId}: ${error && error.message}`);
      }
    }
  }
  if (port && !(await probePagePort(tabId, port))) {
    bwlog(`reconnected page bridge on tab ${tabId} did not acknowledge`);
    ports.delete(tabId);
    if (contentPort === port) contentPort = null;
    return null;
  }
  return port;
}

async function moveTabToProject(tabId, rawUrl) {
  const url = canonicalProjectUrl(rawUrl);
  if (!url) return null;
  let tab = null;
  try { tab = await chrome.tabs.get(tabId); } catch (_) {}
  if (canonicalProjectUrl(tab?.url) !== url) {
    bwlog(`navigating tab ${tabId} to ChatGPT project ${url}`);
    const oldPort = ports.get(tabId);
    ports.delete(tabId);
    if (contentPort === oldPort) contentPort = null;
    await chrome.tabs.update(tabId, { url, active: false });
    await waitForTabLoad(tabId);
  }
  return livePortForTab(tabId, true);
}

async function resolveFolderProject(tabId, port, projectKey, projectName) {
  const mapped = folderProjects[projectKey] || Object.values(folderProjects).find(
    (project) => project?.name === projectName && canonicalProjectUrl(project.url),
  );
  if (mapped?.url && canonicalProjectUrl(mapped.url)) {
    bwlog(`reusing ChatGPT project ${mapped.name} at ${mapped.url}`);
    if (!folderProjects[projectKey]) mapFolderProject(projectKey, projectName, mapped.url);
    return mapped;
  }

  let tab = null;
  try { tab = await chrome.tabs.get(tabId); } catch (_) {}
  const currentUrl = canonicalProjectUrl(tab?.url);
  if (currentUrl) {
    bwlog(`using open ChatGPT project ${projectName} at ${currentUrl}`);
    return mapFolderProject(projectKey, projectName, currentUrl);
  }

  bwlog(`creating or finding ChatGPT project ${projectName}`);
  const result = await requestProjectSetup(tabId, port, projectName);
  if (result?.error) throw new Error(result.error);
  const project = mapFolderProject(projectKey, projectName, result?.url);
  if (!project) throw new Error(`ChatGPT did not return a project for "${projectName}".`);
  return project;
}

async function ensureFolderProject(tabId, port, projectKey, projectName) {
  if (!projectKey || !projectName) return port;
  let task = folderProjectTasks.get(projectKey);
  if (!task) {
    task = resolveFolderProject(tabId, port, projectKey, projectName);
    folderProjectTasks.set(projectKey, task);
    const cleanup = () => {
      if (folderProjectTasks.get(projectKey) === task) folderProjectTasks.delete(projectKey);
    };
    task.then(cleanup, cleanup);
  }
  const project = await task;
  return moveTabToProject(tabId, project.url);
}

// Resolve the tab that owns this conversation, creating it if needed. `url` is the
// conversation's stored ChatGPT link — used only when we have to make a new tab
// (first message, or the old tab was closed), never to re-navigate a live one.
async function tabForConversation(convId, url, projectKey) {
  const existing = convTabs[convId];
  if (existing !== undefined && (await tabAlive(existing))) return { tabId: existing, created: false };
  if (existing !== undefined) forgetTab(existing);
  const target = url || folderProjects[projectKey]?.url || 'https://chatgpt.com/';
  const created = await chrome.tabs.create({ url: target, active: false });
  mapConvTab(convId, created.id);
  bwlog(`opened tab ${created.id} for conv ${convId} at ${target}`);
  return { tabId: created.id, created: true };
}

// Forget a tab when the user closes it, so the next send opens a fresh one.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabConv.has(tabId)) bwlog(`tab ${tabId} closed — unmapping conv ${tabConv.get(tabId)}`);
  forgetTab(tabId);
  if (tabId === contentTabId) contentTabId = null;
});

function connect(url) {
  if (!bridgeEnabled) return;
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  clearTimeout(reconnectTimer);

  try {
    ws = new WebSocket(url);
  } catch (e) {
    setStore({ ws_status: 'error', ws_error: e.message });
    broadcastStatus('error', e.message);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    reconnectCount = 0;
    setStore({ ws_status: 'connected', ws_error: '' });
    broadcastStatus('connected', 'Connected to desktop app');
    wsUrl = url;
    storageReady.then(sendTurnStatus);
  };

  ws.onclose = (e) => {
    ws = null;
    const reason = e.code === 1000 ? 'disconnected' : `lost (code ${e.code})`;
    setStore({ ws_status: 'disconnected', ws_error: reason });
    broadcastStatus('disconnected', reason);
    scheduleReconnect();
  };

  ws.onerror = (e) => {
    const msg = e?.message || 'Connection refused — is the desktop app running?';
    setStore({ ws_status: 'error', ws_error: msg });
    broadcastStatus('error', msg);
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      // The desktop watches the extension source in dev and tells us when it
      // changed, so iterating never requires a manual reload again.
      if (msg.type === 'reload_extension') {
        bwlog('extension source changed — reloading self');
        // MAIN-world hooks survive an extension reload because they belong to the
        // page, not the extension context. Remember that these owned pages need one
        // real refresh after the worker comes back, otherwise they keep the old
        // stream decoder even though the isolated content script is current.
        chrome.storage.local.set({ parallax_refresh_owned_tabs: true }, () => {
          setTimeout(() => { try { chrome.runtime.reload(); } catch (_) {} }, 150);
        });
        return;
      }

      if (msg.type === 'new_chat') {
        handleNewChat(msg.convId);
        return;
      }

      if (msg.type === 'navigate') {
        handleNavigate(msg.url, msg.convId);
        return;
      }

      // Keep page-bound commands ordered per conversation. Uploads must reach a
      // tab before the prompt that refers to them, even when tab recovery awaits.
      const deliveryKey = msg.convId || 'unscoped';
      const previous = deliveryTasks.get(deliveryKey) || Promise.resolve();
      const task = previous
        .catch(() => {})
        .then(() => deliver(msg))
        .catch((e) => bwlog(`deliver failed: ${e && e.message}`));
      deliveryTasks.set(deliveryKey, task);
      task.finally(() => {
        if (deliveryTasks.get(deliveryKey) === task) deliveryTasks.delete(deliveryKey);
      });
    } catch (e) {
      debugLog('Failed to parse WS message:', e);
    }
  };

  function reportNoContentScript(msg) {
    bwlog(`DROPPED ${msg.type} — no content script connected to the ChatGPT page`);
    try {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'No content script connected to ChatGPT — try refreshing the ChatGPT tab.',
      }));
    } catch (_) {}
  }

  // Send a message to the tab that owns msg.convId, opening that tab if needed.
  async function deliver(msg) {
    const convId = msg.convId;

    // "stop" is best-effort by nature: it only means anything if a tab is already
    // generating. Never open a tab, never re-inject, and NEVER report an error for
    // it — clicking Stop used to raise "No content script connected to ChatGPT",
    // which is a scary banner for an action that had already succeeded locally.
    if (msg.type === 'stop') {
      if (convId) settleTurn(convId);
      const tabId = convId !== undefined ? convTabs[convId] : undefined;
      const port = tabId !== undefined ? ports.get(tabId) : ports.values().next().value;
      if (port) port.postMessage({ type: 'stop' });
      else bwlog('stop ignored — no live tab for this conversation');
      return;
    }
    if (msg.type === 'send_files' && convId) {
      const count = stageFiles(convId, msg.files);
      bwlog(`staged ${count} file(s) for conv ${convId} until its next message send`);
      return;
    }
    if (!convId) {
      // No conversation attached (older desktop build) — fall back to any live tab.
      const anyPort = ports.values().next().value;
      if (anyPort) anyPort.postMessage(msg);
      else reportNoContentScript(msg);
      return;
    }

    const { tabId, created } = await tabForConversation(
      convId,
      msg.expectUrl,
      msg.projectKey,
    );
    let port = await livePortForTab(tabId, created);
    if (!port) {
      bwlog(`giving up on tab ${tabId} for conv ${convId}`);
      reportNoContentScript(msg);
      return;
    }

    // Project lookup/creation belongs to the first actual message send. Creating
    // an empty desktop draft, choosing a model, or selecting a file must remain a
    // local action with no ChatGPT Project side effect.
    if (
      msg.type === 'send_message' &&
      !msg.expectUrl &&
      msg.projectKey &&
      msg.projectName
    ) {
      try {
        port = await ensureFolderProject(
          tabId,
          port,
          msg.projectKey,
          msg.projectName,
        );
      } catch (error) {
        bwlog(`project setup failed for conv ${convId}: ${error && error.message}`);
        try {
          ws.send(JSON.stringify({
            type: 'error',
            convId,
            msgId: msg.msgId || '',
            message: error?.message || 'Could not prepare the ChatGPT project.',
          }));
        } catch (_) {}
        return;
      }
      if (!port) {
        reportNoContentScript(msg);
        return;
      }
    }

    if (msg.type === 'send_message') {
      const msgId = msg.msgId || crypto.randomUUID();
      bwlog(`→tab ${tabId} (conv ${convId}) send_message msgId=${msgId}`);
      const stagedFiles = takeStagedFiles(convId);
      rememberTurn(convId, tabId, msg, msgId, stagedFiles);
      try {
        if (stagedFiles.length) {
          bwlog(`→tab ${tabId} (conv ${convId}) send_files count=${stagedFiles.length}`);
          port.postMessage({ type: 'send_files', files: stagedFiles });
        }
        port.postMessage({
          type: 'send_message',
          text: msg.text,
          msgId,
          model: msg.model,
          intelligence: msg.intelligence,
          expectUrl: msg.expectUrl,
        });
      } catch (error) {
        settleTurn(convId, msgId);
        throw error;
      }
    } else if (msg.type === 'edit_message') {
      const msgId = msg.msgId || crypto.randomUUID();
      bwlog(`→tab ${tabId} (conv ${convId}) edit_message msgId=${msgId}`);
      rememberTurn(convId, tabId, msg, msgId);
      try {
        port.postMessage({
          type: 'edit_message',
          text: msg.text,
          msgId,
          originalText: msg.originalText,
          userIndex: msg.userIndex,
          expectUrl: msg.expectUrl,
        });
      } catch (error) {
        settleTurn(convId, msgId);
        throw error;
      }
    } else if (msg.type === 'switch_model') {
      port.postMessage({ type: 'switch_model', model: msg.model, intelligence: msg.intelligence });
    } else if (msg.type === 'send_files') {
      port.postMessage({ type: 'send_files', files: msg.files });
    } else if (msg.type === 'debug') {
      port.postMessage({ type: 'debug', action: msg.action });
    }
  }
}

function stopBridge() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  reconnectCount = 0;
  if (ws) {
    ws.onclose = null;
    try { ws.close(1000); } catch (_) {}
    ws = null;
  }
  setStore({ ws_status: 'disconnected', ws_error: '' });
  for (const port of ports.values()) {
    try { port.postMessage({ type: 'standby' }); } catch (_) {}
  }
}

function startBridge() {
  for (const port of ports.values()) {
    try { port.postMessage({ type: 'resume' }); } catch (_) {}
  }
  chrome.storage.local.get('ws_url', (data) => {
    connect(data.ws_url || DEFAULT_WS_URL);
  });
}

// Empty desktop drafts are local state. Their first message send creates the
// owned tab and resolves the folder's ChatGPT Project.
function handleNewChat(convId) {
  if (convId) bwlog(`new chat deferred until first send for conv ${convId}`);
}

// Switching threads in the app no longer navigates anything — each conversation's
// tab is already sitting on its own chat. We only point a tab at a URL when it had
// to be recreated (app restart, or the user closed it), which tabForConversation
// handles by opening it directly at the stored link.
async function handleNavigate(url, convId) {
  if (!convId || !url) return;
  const existing = convTabs[convId];
  if (existing === undefined || !(await tabAlive(existing))) {
    await tabForConversation(convId, url);
    if (ws) ws.send(JSON.stringify({ type: 'navigating', convId, url }));
    return;
  }

  let tab = null;
  try { tab = await chrome.tabs.get(existing); } catch (_) {}
  if (tab && tab.url === url) {
    // Recovery may discover that ChatGPT already canonicalized back to the right
    // URL. Release the desktop's pending replay without waiting for a reload that
    // will never happen.
    if (ws) ws.send(JSON.stringify({ type: 'ready', convId, url }));
    return;
  }

  bwlog(`navigating tab ${existing} for conv ${convId} → ${url}`);
  ports.delete(existing);
  if (contentTabId === existing) contentPort = null;
  try {
    await chrome.tabs.update(existing, { url, active: false });
    if (ws) ws.send(JSON.stringify({ type: 'navigating', convId, url }));
  } catch (e) {
    bwlog(`navigate failed for tab ${existing}: ${e && e.message}`);
    forgetTab(existing);
    await tabForConversation(convId, url);
    if (ws) ws.send(JSON.stringify({ type: 'navigating', convId, url }));
  }
}

function scheduleReconnect() {
  reconnectCount++;
  const delay = reconnectCount <= 3 ? 1000 : Math.min(3000 * (reconnectCount - 2), 15000);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    connect(wsUrl);
  }, delay);
}

function setStore(obj) {
  chrome.storage.local.set(obj);
}

function broadcastStatus(status, detail) {
  const payload = { type: 'ws_status', status };
  if (detail) payload.detail = detail;
  if (contentPort) contentPort.postMessage(payload);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'parallax-content') return;

  const tabId = port.sender?.tab?.id ?? null;
  let owned = null;            // null = undecided, true = ours, false = someone else's
  let convId = null;
  const buffered = [];         // messages that arrive before ownership is known

  function forward(msg) {
    if (
      tabId != null &&
      (msg?.type === 'project_ready' || msg?.type === 'project_error') &&
      resolveProjectSetup(tabId, msg)
    ) {
      return;
    }
    if (msg?.type === 'sent') acceptTurn(convId, msg.msgId);
    let delivered = false;
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        // Stamp every reply with the conversation that owns this tab, so the
        // desktop routes it by identity instead of inferring from a URL.
        ws.send(JSON.stringify(Object.assign({ convId }, msg)));
        delivered = true;
      }
    } catch (e) {
      debugLog('ws.send failed:', e);
    }
    if (
      delivered &&
      ['response', 'error', 'wrong_conversation'].includes(msg?.type)
    ) {
      settleTurn(convId, msg.msgId);
    }
  }

  // Attach synchronously so nothing sent during the storage wait is lost — the
  // content script posts `ready` the instant it connects.
  port.onMessage.addListener((msg) => {
    if (owned === true && msg?.type === 'page_ready' && resolvePageProbe(tabId, msg.probeId)) {
      return;
    }
    if (owned === true) forward(msg);
    else if (owned === null && buffered.length < 50) buffered.push(msg);
  });

  port.onDisconnect.addListener(() => {
    if (owned === true) {
      bwlog(`content script DISCONNECTED (tab ${tabId})`);
      ports.delete(tabId);
      failPageProbes(tabId);
      if (contentPort === port) contentPort = null;
    }
  });

  storageReady.then(() => {
    convId = tabId == null ? null : tabConv.get(tabId);
    // Only tabs Parallax opened for a conversation take part. The content script is
    // injected into EVERY chatgpt.com tab, so the user's own tabs would otherwise
    // report their conversation URLs and be mistaken for ours.
    if (!convId) {
      owned = false;
      buffered.length = 0;
      bwlog(`ignoring content script from unowned tab ${tabId}`);
      try { port.postMessage({ type: 'standby' }); } catch (_) {}
      return;
    }
    owned = true;
    ports.set(tabId, port);
    notifyPortReady(tabId, port);   // release anything awaiting this tab
    resumeProjectSetups(tabId, port);
    contentPort = port;      // kept for the popup's "page bridge" indicator
    contentTabId = tabId;
    bwlog(`content script CONNECTED (tab ${tabId} → conv ${convId})`);
    try {
      // Clears any earlier standby — a tab can be told to stand down before the
      // mapping loads and must be able to come back.
      port.postMessage({ type: bridgeEnabled ? 'resume' : 'standby' });
      port.postMessage({
        type: 'ws_status',
        status: ws && ws.readyState === WebSocket.OPEN ? 'connected' : 'disconnected',
      });
      const recovery = recoveryMessageForConversation(convId);
      if (recovery) {
        bwlog(`${recovery.type === 'recover_turn' ? 'recovering accepted' : 'resuming pending'} turn ${recovery.msgId} on tab ${tabId}`);
        port.postMessage(recovery);
      }
    } catch (_) {}
    for (const m of buffered) forward(m);
    buffered.length = 0;
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'connect_ws') {
    if (!bridgeEnabled) {
      sendResponse({ ok: false });
      return true;
    }
    connect(msg.url || DEFAULT_WS_URL);
    sendResponse({ ok: true });
  } else if (msg.type === 'set_bridge_enabled') {
    bridgeEnabled = Boolean(msg.enabled);
    chrome.storage.local.set({ parallax_bridge_enabled: bridgeEnabled }, () => {
      if (bridgeEnabled) startBridge();
      else stopBridge();
      sendResponse({ ok: true, enabled: bridgeEnabled });
    });
    return true;
  } else if (msg.type === 'get_status') {
    chrome.storage.local.get(['ws_status', 'ws_error', 'ws_url'], (st) => {
      // Report the LIVE socket state, not just the persisted one — a stale
      // "connected" in storage is what made the popup claim all-good while the
      // page bridge was actually dead.
      const live = ws && ws.readyState === WebSocket.OPEN;
      sendResponse({
        enabled: bridgeEnabled,
        ws: live ? 'connected' : st.ws_status === 'connected' ? 'disconnected' : st.ws_status || 'disconnected',
        url: st.ws_url || wsUrl,
        error: st.ws_error || '',
        // Whether the ChatGPT page actually has a live bridge to us.
        content: bridgeEnabled && Boolean(contentPort),
      });
    });
    return true;
  } else if (msg.type === 'heal_content') {
    if (!bridgeEnabled) {
      sendResponse({ ok: false });
      return true;
    }
    ensureContentScript().then((ok) => sendResponse({ ok }));
    return true;
  }
  return true;
});

// Catch unhandled rejections so Chrome doesn't terminate the SW on a stray error
self.addEventListener('unhandledrejection', (e) => {
  debugLog('unhandled rejection:', e.reason);
  e.preventDefault();
});

function ensureConnected() {
  if (!bridgeEnabled) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  chrome.storage.local.get('ws_url', (data) => {
    connect(data.ws_url || DEFAULT_WS_URL);
  });
}

// MV3 service workers get terminated when idle, which kills the WebSocket AND any
// pending reconnect timers — that's what leaves the desktop showing "No extension
// connected". A chrome.alarms tick survives termination: it wakes the worker on a
// schedule and reconnects if the socket is gone. Combined with the desktop's 10s
// keepalive ping (which keeps us alive WHILE connected), this self-heals the link.
try {
  chrome.alarms.create('parallax-keepalive', { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'parallax-keepalive') ensureConnected();
  });
} catch (_) {}

chrome.runtime.onStartup.addListener(ensureConnected);

// Reloading the extension orphans the content script in every already-open tab
// (its context dies and it can never reconnect). Re-inject into our conversation
// tabs as soon as we come back up, so no manual tab refresh is ever needed.
storageReady.then(() => {
  chrome.storage.local.get('parallax_refresh_owned_tabs', (data) => {
    if (!data || !data.parallax_refresh_owned_tabs) {
      setTimeout(() => { ensureContentScript().catch(() => {}); }, 300);
      return;
    }

    chrome.storage.local.remove('parallax_refresh_owned_tabs');
    Promise.all(Object.entries(convTabs).map(async ([convId, tabId]) => {
      if (!(await tabAlive(tabId))) {
        forgetTab(tabId);
        return;
      }
      ports.delete(tabId);
      try {
        bwlog(`refreshing tab ${tabId} (conv ${convId}) after extension update`);
        await chrome.tabs.reload(tabId);
      } catch (e) {
        bwlog(`tab refresh failed for ${tabId}: ${e && e.message}`);
      }
    })).finally(() => {
      // Let navigation install the manifest scripts first. The recovery probe is
      // only a backstop for a page whose automatic injection did not reconnect.
      setTimeout(() => { ensureContentScript().catch(() => {}); }, 1500);
    });
  });
});

chrome.storage.local.get(['parallax_bridge_enabled', 'ws_url'], (data) => {
  bridgeEnabled = data.parallax_bridge_enabled === true;
  if (bridgeEnabled) startBridge();
  else setStore({ ws_status: 'disconnected', ws_error: '' });
});
