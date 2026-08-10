// Marker the background probes before re-injecting. An extension reload leaves the
// OLD content script running in a dead context — a fresh injection lands in a NEW
// isolated world where this flag is absent, so probing it distinguishes "context is
// dead, safe to inject" from "alive and already reconnecting, do NOT double-inject".
globalThis.__parallaxContentLoaded = true;

let backgroundPort = null;
let sending = false;
// Start inert. The background explicitly resumes only tabs that belong to a Parallax
// conversation; every other ChatGPT tab must remain observationally untouched.
let standby = true;
let currentSend = null; // { msgId, resolved, gotNet, resolve }
let pendingSend = null; // a send that arrived while one was in flight (agent loop)
let recoveringTurn = null; // accepted turn restored after a page-bridge reconnect
let pendingOutbox = []
let reconnectAttempts = 0
const MAX_RECONNECT_ATTEMPTS = 10
let selectionTask = Promise.resolve({ ok: true })
let uploadTask = Promise.resolve()

// Raw model text streamed from the page's network response (via src/inject.js).
// This is complete and un-rendered — no truncation, no HTML tag mangling.
window.addEventListener('message', (e) => {
  const d = e.data;
  if (e.source !== window || !d) return;
  // Real model list scraped from ChatGPT's /backend-api/models response.
  if (d.__parallax_models === true && Array.isArray(d.models)) {
    postToBg({ type: 'models', models: d.models });
    return;
  }
  if (d.__parallax_net_request === true) {
    if (!currentSend || (d.turnId && d.turnId !== currentSend.msgId)) return;
    currentSend.requestStarted = true;
    if (currentSend.requestResolve) {
      currentSend.requestResolve(true);
      currentSend.requestResolve = null;
    }
    wlog(`conversation request started msgId=${currentSend.msgId}`);
    return;
  }
  if (d.__parallax_net_arm_ready === true) {
    if (
      !currentSend ||
      !d.armed ||
      (d.turnId && d.turnId !== currentSend.msgId)
    ) return;
    currentSend.armReady = true;
    if (currentSend.armTimer) {
      clearTimeout(currentSend.armTimer);
      currentSend.armTimer = null;
    }
    if (currentSend.armResolve) {
      currentSend.armResolve(true);
      currentSend.armResolve = null;
    }
    return;
  }
  if (d.__parallax_net_metric === true && d.metric) {
    postToBg({
      type: 'transport_metric',
      ...d.metric,
      msgId: d.metric.turnId || '',
      url: window.location.href,
    });
    return;
  }
  // Raw SSE samples from the page-world hook — relayed so the terminal shows the
  // actual stream shape when the parser stops matching it.
  if (d.__parallax_net_debug === true) { wlog(`sse sample: ${d.sample}`); return; }
  if (d.__parallax_net !== true) return;
  if (!currentSend) {
    console.warn('[Parallax] net response dropped — no currentSend (was port reset?)');
    return;
  }
  if (d.turnId && d.turnId !== currentSend.msgId) {
    wlog(`stale network frame dropped turn=${d.turnId} current=${currentSend.msgId}`);
    return;
  }
  const netText = d.text || '';
  if (netText.length > 0) currentSend.gotNet = true;
  if (d.done) {
    if (currentSend.resolved) return;
    currentSend.resolved = true;
    if (conversationDrifted()) {
      const expected = currentSend.expectUrl || (
        currentSend.convKey ? `https://chatgpt.com/c/${currentSend.convKey}` : ''
      );
      wlog(`network response rejected after conversation drift → ${window.location.href}`);
      postToBg({
        type: 'wrong_conversation',
        msgId: currentSend.msgId,
        expected,
        actual: window.location.href,
      });
    } else if (netText.trim().length > 0) {
      wlog(`response (network) → post ${prev(netText)} url=${window.location.href}`);
      postToBg({
        type: 'response',
        source: 'network',
        text: netText,
        toolCalls: '',
        msgId: currentSend.msgId,
        url: window.location.href,
      });
    } else {
      wlog(`network response completed without answer text (${d.completion || 'unknown completion'})`);
      postToBg({
        type: 'error',
        source: 'network',
        message: 'The network response completed without answer text.',
        msgId: currentSend.msgId,
        url: window.location.href,
      });
    }
    if (currentSend.resolve) currentSend.resolve();
  } else if (netText.length > 0) {
    emitStream(netText);
  }
});

// Network deltas are monotonic. Ignore duplicate or shorter snapshots from another
// physical network transport during a handoff.
let streamHigh = 0;
function resetStream() { streamHigh = 0; }
function emitStream(text) {
  if (!currentSend || !text || text.length <= streamHigh) return;
  // Never stream text off a conversation this turn doesn't belong to. Switching the
  // tab mid-turn used to funnel WHATEVER was on screen — an unrelated chat's answer —
  // straight into the Parallax thread.
  if (conversationDrifted()) return;
  streamHigh = text.length;
  postToBg({ type: 'stream_update', text, msgId: currentSend.msgId, url: window.location.href });
}

function connectBackground() {
  // A reconnect must prove ownership again. This also stops a seed that was
  // scheduled while the old background connection was alive.
  standby = true;
  stopOwnedPageFeatures();
  if (backgroundPort) {
    try { backgroundPort.disconnect(); } catch (_) {}
    backgroundPort = null;
  }

  // If the extension was reloaded, chrome.runtime.id will throw
  // "Extension context invalidated" — detect this and warn the user.
  try {
    if (!chrome.runtime.id) throw new Error('no runtime id');
  } catch (e) {
    console.warn('[Parallax] extension context lost — this page needs a refresh');
    showReloadWarning();
    return;
  }

  try {
    backgroundPort = chrome.runtime.connect({ name: 'parallax-content' });
  } catch (e) {
    reconnectAttempts++;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.warn('[Parallax] max reconnect attempts reached — extension may need a page refresh');
      showReloadWarning();
      return;
    }
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
    console.warn('[Parallax] connect failed (attempt', reconnectAttempts, '):', e.message, '— retry in', delay, 'ms');
    setTimeout(connectBackground, delay);
    return;
  }
  reconnectAttempts = 0;
  backgroundPort.onMessage.addListener(handleMessage);
  backgroundPort.onDisconnect.addListener(() => {
    backgroundPort = null;
    if (chrome.runtime.lastError) {
      console.warn('[Parallax] port disconnected:', chrome.runtime.lastError.message);
    }
    sending = false;
    setTimeout(connectBackground, 500);
  });
  // Flush any messages queued while disconnected
  const queue = pendingOutbox.splice(0);
  for (const msg of queue) {
    try { backgroundPort.postMessage(msg); } catch (e) {
      console.error('[Parallax] flush failed:', e);
    }
  }
  backgroundPort.postMessage({
    type: 'ready',
    url: window.location.href,
  });
}

// ChatGPT is a single-page app: switching conversations swaps the URL via the
// History API WITHOUT reloading the content script, so `ready` never re-fires and
// the desktop's idea of which chat the tab shows goes stale. It then thinks the tab
// is already on the right conversation and types the next message into whatever is
// on screen — that's how a message landed in an unrelated chat. Poll the URL and
// report every change so the desktop can always navigate back to the right thread.
let urlWatchTimer = null;
let lastSeenHref = '';
function watchUrlChanges() {
  if (urlWatchTimer) return;
  lastSeenHref = window.location.href;
  urlWatchTimer = setInterval(() => {
    const href = window.location.href;
    if (href === lastSeenHref) return;
    lastSeenHref = href;
    // Deliberately NOT `ready`: that message also re-binds the desktop thread's
    // saved conversation URL, so reporting a stray navigation as `ready` would
    // permanently attach the thread to whatever chat the user wandered into.
    // `tab_url` only corrects the desktop's view of WHERE THE TAB IS.
    wlog(`url changed → ${href}${sending ? ' (send in flight)' : ''}`);
    if (!sending) postToBg({ type: 'tab_url', url: href });
  }, 700);
}

let modelRequestTimers = [];
function requestModelsFromPage() {
  const ask = () => {
    if (standby) return;
    try { window.postMessage({ __parallax_request_models: true }, '*'); } catch (_) {}
  };
  ask();
  modelRequestTimers = [setTimeout(ask, 1200), setTimeout(ask, 3500)];
}

function startOwnedPageFeatures() {
  standby = false;
  watchUrlChanges();
  // Ask the page-world hook for the model list it has already seen (in case
  // ChatGPT fetched /backend-api/models before ownership was confirmed).
  requestModelsFromPage();
  observeModelMenu();
  scheduleModelMenuSeed();
}

function stopOwnedPageFeatures() {
  if (urlWatchTimer) { clearInterval(urlWatchTimer); urlWatchTimer = null; }
  if (modelMenuObserver) {
    try { modelMenuObserver.disconnect(); } catch (_) {}
    modelMenuObserver = null;
  }
  if (modelMenuSeedTimer) {
    clearTimeout(modelMenuSeedTimer);
    modelMenuSeedTimer = null;
  }
  for (const timer of modelRequestTimers) clearTimeout(timer);
  modelRequestTimers = [];
}

function handleMessage(msg) {
  if (msg.type === 'page_probe') {
    postToBg({ type: 'page_ready', probeId: msg.probeId || '' });
    return;
  }
  // This tab isn't the one Parallax drives — go quiet so we don't report our URL or
  // act on anything meant for the owned tab.
  if (msg.type === 'standby') {
    standby = true;
    stopOwnedPageFeatures();
    console.log('[Parallax] standing down — this is not the Parallax tab');
    return;
  }
  // Standby must be reversible: a tab can be told to stand down before the
  // background has loaded its conversation mapping, and has to come back.
  if (msg.type === 'resume') {
    if (standby) {
      startOwnedPageFeatures();
      console.log('[Parallax] resumed — this tab is Parallax-owned');
    }
    return;
  }
  if (standby) {
    const ownedCommand = [
      'send_message',
      'edit_message',
      'recover_turn',
      'switch_model',
      'stop',
      'send_files',
      'debug',
    ].includes(msg.type);
    if (!ownedCommand) return;
    // Receiving a page command from the background is itself proof that this is
    // the owned tab. Recover if a preceding resume message was lost during an
    // extension reload instead of silently discarding the command.
    startOwnedPageFeatures();
    console.log('[Parallax] resumed from an owned page command');
  }
  switch (msg.type) {
    case 'recover_turn':
      recoverAcceptedTurn(msg);
      break;
    case 'send_message': {
      const filesReady = uploadTask;
      uploadTask = filesReady.catch(() => {});
      filesReady
        .then(() => sendMessageToChatGPT(msg.text, msg.msgId, msg.model, msg.intelligence, msg.expectUrl))
        .catch((error) => {
          postToBg({
            type: 'error',
            message: error?.message || 'Could not attach the preview capture.',
            url: window.location.href,
          });
        });
      break;
    }
    case 'edit_message':
      editMessageInChatGPT(
        msg.text,
        msg.msgId,
        msg.originalText,
        msg.userIndex,
        msg.expectUrl,
      );
      break;
    case 'switch_model':
      // Picking a model in the desktop app switches it on the site immediately
      // (not just at send time). A busy tab reports the failure instead of letting
      // the desktop optimistically claim a change that never happened.
      console.log('[Parallax] switch_model recv → model:', msg.model || '(keep)', '| intelligence:', msg.intelligence || '(keep)', sending ? '(BUSY)' : '');
      if (sending) {
        reportSelectionError({
          message: 'Wait for the current response to finish before changing the model or intelligence.',
        });
      } else {
        selectionTask = selectionTask
          .catch(() => ({ ok: false }))
          .then(() => selectModelViaDom(msg.model, msg.intelligence));
        selectionTask.then((result) => {
          if (!result?.ok) reportSelectionError(result);
        });
      }
      break;
    case 'stop':
      stopGenerating();
      break;
    case 'send_files':
      uploadTask = uploadTask.catch(() => {}).then(() => handleSendFiles(msg.files));
      break;
    case 'debug':
      handleDebug(msg);
      break;
  }
}

const SELECTORS = {
  input: [
    '#prompt-textarea',
    'textarea[placeholder*="Message"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]',
    'textarea:not([aria-hidden="true"])',
  ],
  sendButton: [
    '#composer-submit-button',
    'button.composer-submit-btn',
    'button[data-testid="send-button"]',
    'button[aria-label*="Send" i]',
    'button[aria-label*="Submit" i]',
    'button[type="submit"]',
    '[data-testid="send-button"]',
  ],
  stopButton: [
    'button[data-testid="stop-button"]',
    'button[data-testid="fruitjuice-stop-button"]',
    'button[aria-label*="Stop" i]',
  ],
  fileUpload: [
    'input[type="file"]',
    'button[data-testid*="file" i]',
    'button[aria-label*="attach" i]',
    'button[aria-label*="upload" i]',
    'button[aria-label*="paperclip" i]',
  ],
  modelSelector: [
    'button[data-testid="model-selector-button"]',
    '[data-testid="model-switcher"] button',
    '[data-testid="model-selector-toggle"]',
    'button[class*="model"]',
    'button#model-select',
  ],
  modelOption: [
    '[role="menuitem"]',
    '[role="option"]',
    '[role="menuitemradio"]',
    '[data-testid*="model-option"]',
    '[data-testid*="model-picker"]',
  ],
};

function find(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function findAll(selectors) {
  for (const sel of selectors) {
    const list = document.querySelectorAll(sel);
    if (list.length > 0) return list;
  }
  return [];
}

// ── Model picker: read ChatGPT's OWN menu from the DOM (DOM-only) ──────────────
// Structure (from the live DOM):
//   • Main menu  [data-testid="composer-intelligence-picker-content"]:
//       "Intelligence" label
//       menuitemradio × N  → the CURRENT model's intelligence options
//                            (label in .truncate, optional hint in a tertiary span)
//       separator
//       menuitem[aria-haspopup] → the current model row (.truncate = model name)
//   • Submenu (opens when the model row is hovered):
//       menuitemradio × N  → the model list (name in .truncate, optional sublabel)
// Intelligence is only in the DOM for whichever model is current, so the desktop
// accumulates it per-model as different models become current. Nothing hardcoded.
let lastMenuSig = '';

function rowLabel(el) {
  const t = el.querySelector('.truncate');
  return (t ? t.textContent : el.textContent || '').trim();
}

// Secondary text (tertiary color) inside a row, excluding the main label — e.g.
// "5.3" next to Instant, or "Leaving on July 23" under GPT-5.4.
function rowSubtext(el, label) {
  const n = [...el.querySelectorAll('span,div')].find(
    (x) => /text-token-text-tertiary/.test(x.className || '') && x.textContent.trim() && x.textContent.trim() !== label,
  );
  return n ? n.textContent.trim() : '';
}

// Does this row's label name a MODEL (vs. an intelligence tier like Instant/High)?
function looksLikeModel(label) {
  return /\b(gpt|o\d|sonnet|opus|claude|research|codex)\b/i.test(label || '');
}

function scrapeModelMenu(force = false) {
  try {
    const radios = [...document.querySelectorAll('[role="menuitemradio"]')].filter((e) => e.offsetParent !== null);
    if (!radios.length) return null;

    // Split radios by WHAT THEY ARE, not by DOM container: a model name vs a
    // reasoning tier. This doesn't depend on ChatGPT's testids/nesting, so a
    // markup tweak can't misfile the intelligence tiers as models (the bug).
    const models = [];
    const intelligences = [];
    for (const e of radios) {
      const label = rowLabel(e);
      if (!label) continue;
      const row = {
        label,
        hint: rowSubtext(e, label),
        checked: e.getAttribute('aria-checked') === 'true' || e.getAttribute('data-state') === 'checked',
      };
      if (looksLikeModel(label)) models.push({ title: label, sublabel: row.hint, checked: row.checked });
      else intelligences.push(row);
    }

    // Current model = the model row (menuitem w/ submenu) anywhere in an open menu;
    // fall back to the checked model in the list.
    let currentModel = '';
    const modelRow = document.querySelector('[role="menu"] [role="menuitem"][aria-haspopup="menu"], [role="menu"] [role="menuitem"][data-has-submenu]');
    if (modelRow) currentModel = rowLabel(modelRow);
    if (!currentModel) { const c = models.find((m) => m.checked); if (c) currentModel = c.title; }
    const currentIntelligence = intelligences.find((i) => i.checked)?.label || '';

    if (!models.length && !intelligences.length) return null;
    const sig = JSON.stringify({ models, intelligences, currentModel, currentIntelligence });
    if (sig === lastMenuSig && !force) {
      return { models, intelligences, currentModel, currentIntelligence };
    }
    lastMenuSig = sig;
    postToBg({ type: 'models', models, intelligences, currentModel, currentIntelligence });
    console.log('[Parallax] model menu →', currentModel || '(?)',
      '| models:', models.map((m) => m.title).join(', ') || '(none yet, hover the model row)',
      '| intelligence:', intelligences.map((i) => i.label + (i.checked ? ' ✓' : '') + (i.hint ? ` (${i.hint})` : '')).join(', ') || '(none)');
    return { models, intelligences, currentModel, currentIntelligence };
  } catch (_) {
    return null;
  }
}

// Watch for the model menu (or its intelligence submenu) appearing and scrape it.
let modelMenuObserver = null;
function observeModelMenu() {
  if (standby || modelMenuObserver) return;
  try {
    modelMenuObserver = new MutationObserver(() => {
      if (document.querySelector('[role="menuitemradio"]')) {
        setTimeout(() => { if (!standby) scrapeModelMenu(); }, 120);
      }
    });
    modelMenuObserver.observe(document.body, { childList: true, subtree: true });
  } catch (_) {
    modelMenuObserver = null;
  }
}

// One-time gentle seed after ownership is confirmed: open the model menu, scrape
// the current model's intelligence + the model list, then close — so the desktop
// picker is populated without the user having to open ChatGPT's menu themselves.
// Polls for the composer button (ChatGPT is an SPA and hydrates late). Skipped if
// the user already opened the menu first.
let seededMenu = false;
let seedingMenu = false;
let modelMenuSeedTimer = null;

function scheduleModelMenuSeed() {
  if (standby || seededMenu || seedingMenu || modelMenuSeedTimer) return;
  modelMenuSeedTimer = setTimeout(() => {
    modelMenuSeedTimer = null;
    if (!standby) seedModelMenu();
  }, 3000);
}

async function seedModelMenu() {
  if (standby || seededMenu || seedingMenu) return;
  seedingMenu = true;
  try {
    // Wait (up to ~20s) for the composer's model button to render.
    let trigger = null;
    for (let i = 0; i < 40; i++) {
      if (standby) return;
      if (lastMenuSig) {
        seededMenu = true;
        console.log('[Parallax] seed skipped — menu already captured');
        return;
      }
      trigger = findModelTrigger();
      if (trigger) break;
      await sleep(500);
    }
    if (!trigger) { console.warn('[Parallax] seed: model button not found after 20s'); return; }
    if (standby) return;
    seededMenu = true;
    console.log('[Parallax] seeding model menu via', (trigger.textContent || '').trim().slice(0, 24));
    openModelMenu(trigger);
    await sleep(500);
    scrapeModelMenu(); // current model's intelligence tiers (+ current model)
    // Reveal the model list submenu by hovering the current-model row (sibling of
    // the intelligence picker, so query the whole menu).
    const menu = document.querySelector('[data-testid="composer-intelligence-picker-content"]')?.closest('[role="menu"]');
    const modelRow = menu && menu.querySelector('[role="menuitem"][aria-haspopup="menu"], [role="menuitem"][data-has-submenu]');
    if (modelRow) {
      openModelSubmenu(modelRow);
      await sleep(500);
      scrapeModelMenu(); // the model list
    } else {
      console.warn('[Parallax] seed: model row not found (menu may not have opened)');
    }
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(150);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  } catch (e) {
    console.warn('[Parallax] seed failed:', e);
  } finally {
    seedingMenu = false;
  }
}

function testSelectors() {
  const result = {};
  for (const [key, list] of Object.entries(SELECTORS)) {
    const found = [];
    for (const sel of list) {
      const el = document.querySelector(sel);
      found.push({
        selector: sel,
        match: el
          ? `${el.tagName.toLowerCase()}#${el.id || ''}.${(el.className || '').toString().slice(0, 40)}`
          : null,
      });
    }
    result[key] = found;
  }

  result.other = {};
  const inputContainer = find(SELECTORS.input)?.closest('form, div');
  if (inputContainer) {
    result.other.containerTag = inputContainer.tagName;
    result.other.containerChildren = Array.from(inputContainer.children).map(
      (c) => `${c.tagName}${c.id ? '#' + c.id : ''}${c.className ? '.' + c.className.toString().slice(0, 20) : ''}`
    );
  }

  result.buttonsOnPage = Array.from(document.querySelectorAll('button')).slice(0, 30).map(
    (b) => `${b.tagName}#${b.id || ''}[data-testid="${b.getAttribute('data-testid') || ''}"][aria-label="${(b.getAttribute('aria-label') || '').slice(0, 20)}"] visible=${b.offsetParent !== null}`
  );

  return result;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Resolve the INSTANT `check()` returns something truthy, driven by DOM mutations
 * rather than by waiting a guessed number of milliseconds.
 *
 * Fixed sleeps were pacing this whole harness: "wait 400ms for the composer",
 * "wait 1.2s after the answer looks done". They are always simultaneously too slow
 * (dead time on every turn) and too short (flaky when the page is busy). The DOM
 * already tells us exactly when something happened — listen to it.
 *
 * `failsafeMs` is ONLY a last-resort escape so a hung page can't block forever; it
 * is never the normal path.
 */
function waitForDom(check, failsafeMs = 120000) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let obs = null;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { if (obs) obs.disconnect(); } catch (_) {}
      resolve(v);
    };
    const evaluate = () => {
      let v = null;
      try { v = check(); } catch (_) {}
      if (v) finish(v);
    };
    if (document.body) {
      obs = new MutationObserver(evaluate);
      obs.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
    }
    timer = setTimeout(() => finish(null), failsafeMs);
    evaluate(); // already true?
  });
}

// DOM-only model + intelligence switching: click through ChatGPT's own menu, the
// same way a person would. No slugs exist in the menu DOM, so this is the only way
// to change the model. Every requested value is confirmed from ChatGPT's checked
// menu state before Parallax is allowed to submit a message.

// The composer button that opens the model/intelligence menu (shows the model name).
// STRICT on purpose: this element gets a real click, so a wrong match is not a
// no-op — clicking a sidebar conversation row NAVIGATES the tab, which is how a
// message once landed in an unrelated chat. We therefore require an actual menu
// trigger (aria-haspopup="menu") and never look inside the history sidebar. If no
// genuine trigger is found we return null and simply skip switching.
function findModelTrigger() {
  const inSidebar = (el) => !!el.closest('nav, aside, [data-testid*="history" i], [class*="sidebar" i]');
  const input = find(SELECTORS.input);
  const composer =
    input?.closest('form') ||
    input?.closest('[data-testid*="composer" i], [class*="composer" i]') ||
    input?.parentElement?.parentElement ||
    null;
  const scope = composer || document;
  const btns = [...scope.querySelectorAll('button, [role="button"]')].filter(
    (b) => b.offsetParent !== null && !inSidebar(b),
  );
  const description = (b) => [
    b.textContent,
    b.getAttribute('aria-label'),
    b.getAttribute('title'),
    b.getAttribute('data-testid'),
  ].filter(Boolean).join(' ').trim();
  // ChatGPT's current composer trigger is often only the selected intelligence
  // tier ("Instant"), not the model name. Keep the match scoped to the composer,
  // require menu semantics, and explicitly exclude attachment/tool controls.
  const named = (b) =>
    /\b(gpt|o\d|instant|medium|high|thinking|auto|fast|deep|pro|\d+(?:\.\d+)?\s*(?:sol|terra|luna))\b/i.test(description(b));
  const isMenu = (b) => b.getAttribute('aria-haspopup') === 'menu';
  const isNonModelMenu = (b) => /\b(add|attach|upload|file|tool|voice)\b/i.test(description(b));
  return (
    btns.find((b) => /model-switcher|model-selector|intelligence-picker/i.test(b.getAttribute('data-testid') || '')) ||
    btns.find((b) => isMenu(b) && named(b)) ||
    // Last resort: there should be only one non-attachment menu trigger beside
    // the prompt. It remains constrained to the composer, never the chat sidebar.
    btns.find((b) => isMenu(b) && !isNonModelMenu(b)) ||
    null
  );
}

function openModelMenu(trigger) {
  // Radix opens its trigger on pointerdown, so fire the full pointer sequence,
  // not just a bare click.
  const o = { bubbles: true, cancelable: true, view: window };
  try { trigger.dispatchEvent(new PointerEvent('pointerdown', { ...o, button: 0, pointerId: 1 })); } catch (_) {}
  try { trigger.dispatchEvent(new MouseEvent('mousedown', { ...o, button: 0 })); } catch (_) {}
  try { trigger.dispatchEvent(new PointerEvent('pointerup', { ...o, button: 0, pointerId: 1 })); } catch (_) {}
  try { trigger.dispatchEvent(new MouseEvent('mouseup', { ...o, button: 0 })); } catch (_) {}
  trigger.dispatchEvent(new MouseEvent('click', o));
}

function realClick(el) {
  const o = { bubbles: true, cancelable: true, view: window };
  try { el.dispatchEvent(new PointerEvent('pointerdown', { ...o, button: 0, pointerId: 1 })); } catch (_) {}
  try { el.dispatchEvent(new MouseEvent('mousedown', { ...o, button: 0 })); } catch (_) {}
  try { el.dispatchEvent(new PointerEvent('pointerup', { ...o, button: 0, pointerId: 1 })); } catch (_) {}
  try { el.dispatchEvent(new MouseEvent('mouseup', { ...o, button: 0 })); } catch (_) {}
  el.dispatchEvent(new MouseEvent('click', o));
}

function composerText(input) {
  if (!input) return '';
  if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') return input.value || '';
  return input.innerText || input.textContent || '';
}

function sameComposerText(left, right) {
  const normalize = (value) => String(value || '').replace(/\u00a0/g, ' ').replace(/\r\n/g, '\n').trim();
  return normalize(left) === normalize(right);
}

function setComposerText(input, text) {
  if (!input) return '';
  input.focus();

  if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
    const prototype = input.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (nativeSetter) nativeSetter.call(input, text);
    else input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return composerText(input);
  }

  if (input.isContentEditable) {
    let inserted = false;
    try {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      selection.removeAllRanges();
      selection.addRange(range);
      inserted = document.execCommand('insertText', false, text);
    } catch (_) {}

    if (!inserted || !sameComposerText(composerText(input), text)) {
      input.textContent = text;
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: text ? 'insertText' : 'deleteContent',
        data: text || null,
      }));
    }
  }
  return composerText(input);
}

function submissionAccepted(requestStarted) {
  return Boolean(requestStarted);
}

function clearComposerIfMatches(input, injectedText) {
  const currentInput = find(SELECTORS.input);
  if (!currentInput || currentInput !== input) return;
  if (sameComposerText(composerText(currentInput), injectedText)) setComposerText(currentInput, '');
}

function openModelSubmenu(modelRow) {
  const common = { bubbles: true, cancelable: true, view: window };
  for (const type of ['pointerover', 'pointerenter', 'pointermove']) {
    try {
      modelRow.dispatchEvent(new PointerEvent(type, {
        ...common,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
      }));
    } catch (_) {}
  }
  for (const type of ['mouseover', 'mouseenter', 'mousemove']) {
    try { modelRow.dispatchEvent(new MouseEvent(type, common)); } catch (_) {}
  }
  // Radix-style submenus also support keyboard expansion. This is a deterministic
  // backstop for background tabs where synthetic hover state can be throttled.
  try { modelRow.focus(); } catch (_) {}
  try {
    modelRow.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      code: 'ArrowRight',
      bubbles: true,
      cancelable: true,
    }));
  } catch (_) {}
}

function openMenuEl() {
  return document.querySelector('[data-testid="composer-intelligence-picker-content"]')?.closest('[role="menu"]') ||
    document.querySelector('[role="menu"]');
}

// Resolve the instant the intelligence picker renders its options.
function waitForPicker() {
  return waitForDom(() => {
    const p = document.querySelector('[data-testid="composer-intelligence-picker-content"]');
    return p && p.querySelector('[role="menuitemradio"]') ? p : null;
  }, 8000);
}

function rowIsChecked(el) {
  return !!el && (
    el.getAttribute('aria-checked') === 'true' ||
    el.getAttribute('data-state') === 'checked'
  );
}

async function ensurePickerOpen(trigger) {
  let picker = document.querySelector('[data-testid="composer-intelligence-picker-content"]');
  if (!picker) {
    // Changing models can replace the composer trigger node. Prefer the fresh
    // control and only fall back to the original reference if it is still live.
    const liveTrigger = findModelTrigger() || (trigger?.isConnected ? trigger : null);
    if (liveTrigger) openModelMenu(liveTrigger);
  }
  picker = await waitForPicker();
  return picker;
}

// Loose intelligence-label match: exact first, then compare with any parenthetical
// hint (e.g. "Instant (5.5)") and surrounding whitespace stripped off both sides.
function intelKey(s) {
  return (s || '').toLowerCase().replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
}

// Normalize model/tier text for comparison. The composer button abbreviates the
// model ("5.6 Sol") while the desktop stores the menu's full title ("GPT-5.6 Sol"),
// so drop a leading "GPT-" and collapse whitespace before matching.
function normModelText(s) {
  return (s || '').toLowerCase().replace(/gpt[-\s]*/g, '').replace(/\s+/g, ' ').trim();
}

// Switch the model (and/or intelligence tier) by clicking through ChatGPT's own
// menu, the way a person would. No slugs exist in the DOM, so this is the only way.
async function selectModelViaDom(model, intelligence) {
  const requested = { model: model || '', intelligence: intelligence || '' };
  const fail = (message, state = null) => ({
    ok: false,
    message,
    currentModel: state?.currentModel || '',
    currentIntelligence: state?.currentIntelligence || '',
  });
  const finish = async (result) => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitForDom(() => (openMenuEl() ? null : true), 2000);
    return result;
  };
  try {
    // A freshly-created background tab connects its content script before
    // ChatGPT finishes hydrating the composer. Wait for the real control instead
    // of treating that normal startup window as a failed selection.
    const trigger = await waitForDom(() => findModelTrigger(), 20000);
    if (!trigger) {
      const message = 'Could not find ChatGPT’s model and intelligence control.';
      wlog(`switch FAILED: ${message}`);
      return fail(message);
    }

    console.log('[Parallax] switch → model:', model || '(keep)', '| intelligence:', intelligence || '(keep)');
    if (!document.querySelector('[data-testid="composer-intelligence-picker-content"]')) {
      openModelMenu(trigger);
    }
    let picker = await waitForPicker();
    if (!picker) {
      const message = 'ChatGPT’s model menu did not open.';
      wlog(`switch FAILED: ${message}`);
      return await finish(fail(message));
    }

    // 1) MODEL.
    if (model) {
      const menu = picker.closest('[role="menu"]') || openMenuEl();
      const modelRow = menu && menu.querySelector('[role="menuitem"][aria-haspopup="menu"], [role="menuitem"][data-has-submenu]');
      const currentModel = modelRow ? rowLabel(modelRow) : '';
      if (currentModel && normModelText(currentModel) === normModelText(model)) {
        wlog(`switch: model already active (${currentModel})`);
      } else if (modelRow) {
        openModelSubmenu(modelRow);
        // The submenu is open once a model-looking radio is visible.
        await waitForDom(
          () => [...document.querySelectorAll('[role="menuitemradio"]')]
            .some((r) => r.offsetParent !== null && looksLikeModel(rowLabel(r))) || null,
          8000,
        );
      } else {
        const state = scrapeModelMenu(true);
        const message = 'ChatGPT’s current-model row was not present in the menu.';
        wlog(`switch FAILED: ${message}`);
        return await finish(fail(message, state));
      }

      if (!currentModel || normModelText(currentModel) !== normModelText(model)) {
        const target = [...document.querySelectorAll('[role="menuitemradio"]')].find(
          (r) =>
            r.offsetParent !== null &&
            looksLikeModel(rowLabel(r)) &&
            normModelText(rowLabel(r)) === normModelText(model),
        );
        if (!target) {
          const state = scrapeModelMenu(true);
          const visible = [...document.querySelectorAll('[role="menuitemradio"]')]
            .filter((r) => r.offsetParent !== null && looksLikeModel(rowLabel(r)))
            .map((r) => rowLabel(r))
            .join(' | ');
          const message = `Model "${model}" is not available in ChatGPT’s menu${visible ? ` (${visible})` : ''}.`;
          wlog(`switch FAILED: ${message}`);
          return await finish(fail(message, state));
        }
        realClick(target);
        console.log('[Parallax] switch: clicked model', model);
        // Selecting a model may close the whole popup. Reopen it and verify the
        // fresh current-model row instead of reading the detached clicked node.
        await waitForDom(
          () => (!target.isConnected || rowIsChecked(target) ? true : null),
          3000,
        );
        picker = await ensurePickerOpen(trigger);
        const confirmedMenu = picker?.closest('[role="menu"]');
        const confirmedModelRow = confirmedMenu?.querySelector(
          '[role="menuitem"][aria-haspopup="menu"], [role="menuitem"][data-has-submenu]',
        );
        if (!confirmedModelRow || normModelText(rowLabel(confirmedModelRow)) !== normModelText(model)) {
          picker = null;
        }
        if (!picker) {
          const message = `ChatGPT did not confirm model "${model}".`;
          wlog(`switch FAILED: ${message}`);
          return await finish(fail(message));
        }
      }
    }

    // 2) INTELLIGENCE tier for the now-current model.
    if (intelligence) {
      // Make sure the menu (with the picker) is open — poll rather than a single
      // fixed wait, since the picker can lag the menu-open on a slow/background tab.
      if (!document.querySelector('[data-testid="composer-intelligence-picker-content"]')) {
        openModelMenu(trigger);
      }
      picker = await waitForPicker();
      const radios = picker ? [...picker.querySelectorAll('[role="menuitemradio"]')] : [];
      // Exact label match first; fall back to a hint-insensitive comparison.
      const want = intelligence.toLowerCase();
      const el =
        radios.find((r) => rowLabel(r).toLowerCase() === want) ||
        radios.find((r) => intelKey(rowLabel(r)) === intelKey(intelligence));
      if (el) {
        let checked = rowIsChecked(el);
        if (!checked) {
          realClick(el);
          // A successful radio choice normally closes the popup. Wait for either
          // the checked state or that close, then reopen and read a fresh row.
          await waitForDom(
            () => (rowIsChecked(el) || !el.isConnected ? true : null),
            3000,
          );
          picker = await ensurePickerOpen(trigger);
          const freshRadios = picker ? [...picker.querySelectorAll('[role="menuitemradio"]')] : [];
          const fresh =
            freshRadios.find((r) => rowLabel(r).toLowerCase() === want) ||
            freshRadios.find((r) => intelKey(rowLabel(r)) === intelKey(intelligence));
          checked = rowIsChecked(fresh);
        }
        if (!checked) {
          const state = scrapeModelMenu(true);
          const message = `ChatGPT did not confirm intelligence "${intelligence}".`;
          wlog(`switch FAILED: ${message}`);
          return await finish(fail(message, state));
        }
        console.log('[Parallax] switch: confirmed intelligence', intelligence);
      } else {
        const state = scrapeModelMenu(true);
        const visible = radios.filter((r) => r.offsetParent !== null).map((r) => rowLabel(r)).join(' | ');
        const message = `Intelligence "${intelligence}" is not available in ChatGPT’s menu${visible ? ` (${visible})` : ''}.`;
        wlog(`switch FAILED: ${message}`);
        return await finish(fail(message, state));
      }
    }

    const state = scrapeModelMenu(true);
    if (model && normModelText(state?.currentModel) !== normModelText(model)) {
      return await finish(fail(`ChatGPT reports model "${state?.currentModel || 'unknown'}", not "${model}".`, state));
    }
    if (intelligence && intelKey(state?.currentIntelligence) !== intelKey(intelligence)) {
      return await finish(fail(`ChatGPT reports intelligence "${state?.currentIntelligence || 'unknown'}", not "${intelligence}".`, state));
    }
    wlog(`switch CONFIRMED model=${state?.currentModel || requested.model || '-'} intel=${state?.currentIntelligence || requested.intelligence || '-'}`);
    return await finish({
      ok: true,
      currentModel: state?.currentModel || requested.model,
      currentIntelligence: state?.currentIntelligence || requested.intelligence,
    });
  } catch (e) {
    console.warn('[Parallax] selectModelViaDom failed:', e);
    return fail(e?.message || 'Unexpected error while changing the ChatGPT model.');
  }
}

function reportSelectionError(result) {
  postToBg({
    type: 'selection_error',
    message: result?.message || 'Could not apply the selected model or intelligence.',
    currentModel: result?.currentModel || '',
    currentIntelligence: result?.currentIntelligence || '',
  });
}

// ChatGPT conversation id out of a URL: https://chatgpt.com/c/<id> → "<id>".
function conversationId(url) {
  return globalThis.ParallaxProtocolCore?.conversationId(url) || null;
}

// THE guarantee that a message lands in the right chat. The desktop stores each
// thread's ChatGPT link; we verify the tab is ACTUALLY on that conversation right
// before typing, rather than trusting any cached idea of where the tab is. If it
// doesn't match we refuse to type and tell the desktop to navigate first.
function conversationMismatch(expectUrl) {
  const want = conversationId(expectUrl);
  if (!want) return null; // brand-new thread — no conversation to be wrong about
  const have = conversationId(window.location.href);
  return want === have ? null : { expected: expectUrl, actual: window.location.href };
}

// Has the tab wandered off THIS TURN'S conversation while we were waiting?
//
// conversationMismatch() only guards the moment we type. Network frames can still
// arrive after the tab has moved, so completion checks the conversation identity
// again before posting the answer.
//
// A brand-new chat legitimately starts at "/" with no id and gets one assigned, so
// a null id is never drift — the first real id is ADOPTED as this turn's identity.
function conversationDrifted() {
  if (!currentSend) return false;
  const have = conversationId(window.location.href);
  if (!have) return false;                    // still on "/" — id not assigned yet
  if (!currentSend.convKey) { currentSend.convKey = have; return false; } // adopt
  return currentSend.convKey !== have;
}

// Turn the page-world network hooks (src/inject.js) on and off. They are ONLY on
// while Parallax is driving a turn in this tab.
function armNetHooks(on, turnId) {
  if (!on) {
    try {
      window.postMessage({ __parallax_arm: true, armed: false, turnId: turnId || '' }, '*');
    } catch (_) {}
    return Promise.resolve(true);
  }
  if (!currentSend) return Promise.resolve(false);
  const send = currentSend;
  send.armReady = false;
  const ready = new Promise((resolve) => {
    send.armResolve = resolve;
    send.armTimer = setTimeout(() => {
      if (send.armReady) return;
      send.armResolve = null;
      send.armTimer = null;
      resolve(false);
    }, 5000);
  });
  try {
    window.postMessage({ __parallax_arm: true, armed: true, turnId: turnId || '' }, '*');
  } catch (_) {
    if (send.armTimer) clearTimeout(send.armTimer);
    send.armTimer = null;
    send.armResolve = null;
    return Promise.resolve(false);
  }
  return ready;
}

// The desktop's Stop button. Click ChatGPT's own stop control and unwind whatever
// wait is in flight. Marking the send resolved is what keeps this quiet: the race
// below would otherwise land on "Send timed out" and throw an error banner at the
// user right after they deliberately stopped the turn.
function stopGenerating() {
  const btn = find(SELECTORS.stopButton);
  wlog(`stop requested — ${btn ? 'clicking ChatGPT stop button' : 'nothing generating'}`);
  if (btn) { try { btn.click(); } catch (_) {} }
  pendingSend = null;
  if (recoveringTurn) recoveringTurn.cancelled = true;
  if (currentSend && !currentSend.resolved) {
    if (currentSend.armTimer) clearTimeout(currentSend.armTimer);
    currentSend.armTimer = null;
    if (currentSend.armResolve) currentSend.armResolve(false);
    currentSend.armResolve = null;
    currentSend.resolved = true;
    if (currentSend.resolve) currentSend.resolve();
  }
}

async function sendMessageToChatGPT(text, msgId, model, intelligence, expectUrl) {
  const mismatch = conversationMismatch(expectUrl);
  if (mismatch) {
    wlog(`send REFUSED — tab is on ${mismatch.actual} but this thread is ${mismatch.expected}`);
    postToBg({ type: 'wrong_conversation', msgId, expected: mismatch.expected, actual: mismatch.actual });
    return;
  }
  if (sending) {
    // An agent-loop follow-up can race the previous turn's teardown. Queue it and
    // run it when the current send finishes — never surface "Already sending" (that
    // errored the desktop and flipped Stop back to Send mid-response).
    wlog(`send_message QUEUED (already sending) msgId=${msgId} ${prev(text)}`);
    pendingSend = { text, msgId, model, intelligence, expectUrl };
    return;
  }
  wlog(`send_message START msgId=${msgId} model=${model || '-'} intel=${intelligence || '-'} ${prev(text)}`);
  sending = true;
  // Bind this turn to a conversation. `convKey` may start null for a brand-new
  // chat (no /c/<id> yet) — the first id ChatGPT assigns is adopted below.
  currentSend = {
    msgId,
    resolved: false,
    gotNet: false,
    resolve: null,
    requestStarted: false,
    requestResolve: null,
    armReady: false,
    armResolve: null,
    armTimer: null,
    convKey: conversationId(expectUrl),
    expectUrl,
  };
  // Switch the page-world hooks ON for the duration of this turn only. The turn id
  // prevents late frames from an earlier response entering the next one.
  resetStream();
  const netDone = new Promise((res) => { currentSend.resolve = res; });

  try {
    if (!(await armNetHooks(true, msgId))) {
      throw new Error('The network response hook did not become ready.');
    }
    if (model || intelligence) {
      // Let an immediate picker change finish first, then independently verify the
      // exact selection requested by this message. A failure aborts the send rather
      // than quietly submitting with ChatGPT's previous model.
      await selectionTask.catch(() => null);
      const selection = await selectModelViaDom(model, intelligence);
      if (!selection?.ok) {
        reportSelectionError(selection);
        throw new Error(selection?.message || 'Could not confirm the selected model or intelligence.');
      }
    }
    let input = null;
    let injectedText = '';
    let accepted = false;
    for (let attempt = 0; attempt < 2 && !accepted; attempt++) {
      // A recovered task tab can report "complete" before ChatGPT has hydrated the
      // composer. Wait until the live editor both exists and accepts the exact
      // text; an early placeholder node can be replaced during hydration.
      const prepared = await waitForDom(() => {
        const candidate = find(SELECTORS.input);
        if (!candidate) return null;
        const inserted = setComposerText(candidate, text);
        return sameComposerText(inserted, text)
          ? { input: candidate, injectedText: inserted }
          : null;
      }, 30000);
      if (!prepared) break;
      input = prepared.input;
      injectedText = prepared.injectedText;

      const sendBtn = await waitForDom(() => {
        const button = find(SELECTORS.sendButton);
        return button &&
          !button.disabled &&
          button.getAttribute('aria-disabled') !== 'true'
          ? button
          : null;
      }, 30000);
      if (!sendBtn) break;

      wlog(`submit clicked msgId=${msgId} attempt=${attempt + 1} — awaiting network request`);
      realClick(sendBtn);
      accepted = await Promise.race([
        new Promise((resolve) => {
          if (currentSend?.requestStarted) resolve(true);
          else if (currentSend) currentSend.requestResolve = resolve;
          else resolve(false);
        }),
        sleep(8000).then(() => false),
      ]);
      if (!accepted && currentSend) currentSend.requestResolve = null;
      if (!accepted && attempt === 0) {
        wlog(`submit produced no conversation request msgId=${msgId} — retrying hydrated composer`);
      }
    }
    if (!accepted) {
      if (input) clearComposerIfMatches(input, injectedText);
      throw new Error('ChatGPT did not accept the submitted message.');
    }
    // The desktop already rendered the user's message optimistically. This
    // acknowledgement marks that same message delivered.
    wlog(`submit accepted msgId=${msgId}`);
    postToBg({ type: 'sent', msgId, url: window.location.href });

    console.log('[Parallax] waiting for network response');
    const outcome = await Promise.race([
      netDone.then(() => ({ kind: 'net' })),
      sleep(180000).then(() => ({ kind: 'timeout' })),
    ]);

    wlog(`response outcome=${outcome.kind} gotNet=${currentSend?.gotNet} resolved=${currentSend?.resolved}`);
    if (!currentSend.resolved && outcome.kind === 'timeout') {
      currentSend.resolved = true;
      wlog('network response timed out');
      postToBg({
        type: 'transport_metric',
        msgId,
        source: 'network',
        status: 'timeout',
        chars: 0,
        domFallbacks: 0,
        durationMs: 180000,
        url: window.location.href,
      });
      postToBg({
        type: 'error',
        source: 'network',
        message: 'The network response timed out.',
        msgId,
        url: window.location.href,
      });
    }
  } catch (err) {
    if (!currentSend || !currentSend.resolved) {
      wlog(`send threw: ${err.message} — posting error`);
      postToBg({ type: 'error', message: err.message, msgId, url: window.location.href });
    }
  } finally {
    sending = false;
    currentSend = null;
    // Unhook the page again the moment our turn is over (before draining a queued
    // follow-up, which re-arms on its own).
    void armNetHooks(false, msgId);
    // Drain a queued follow-up (agent loop) immediately. There's no settle delay:
    // sendMessageToChatGPT already waits (on a MutationObserver) for the composer
    // to accept the text and arm its send button, so a fixed pause here only ever
    // added latency to every single loop iteration.
    if (pendingSend) {
      const next = pendingSend;
      pendingSend = null;
      sendMessageToChatGPT(next.text, next.msgId, next.model, next.intelligence, next.expectUrl);
    }
  }
}

function compactMessageText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function renderedMessageText(element) {
  if (!element) return '';
  const body = element.querySelector?.('.markdown') || element;
  return String(body.innerText || body.textContent || '').trim();
}

function isCompleteParallaxResponse(value) {
  const text = String(value || '').trim();
  const opening = /\{plx:(note|run|write|patch|done)\b[^}]*\}/g;
  let cursor = 0;
  let found = false;
  let match = null;
  while ((match = opening.exec(text)) !== null) {
    if (text.slice(cursor, match.index).trim()) return false;
    const close = `{/plx:${match[1]}}`;
    const closeAt = text.indexOf(close, opening.lastIndex);
    if (closeAt < 0) return false;
    found = true;
    cursor = closeAt + close.length;
    opening.lastIndex = cursor;
  }
  return found && text.slice(cursor).trim() === '';
}

function completedResponseAfterPrompt(prompt) {
  const expected = compactMessageText(prompt);
  if (!expected) return '';
  const messages = [...document.querySelectorAll('[data-message-author-role]')];
  let userIndex = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].getAttribute('data-message-author-role') !== 'user') continue;
    if (compactMessageText(renderedMessageText(messages[i])) === expected) userIndex = i;
  }
  if (userIndex < 0) return '';
  for (let i = userIndex + 1; i < messages.length; i++) {
    if (messages[i].getAttribute('data-message-author-role') !== 'assistant') continue;
    const text = renderedMessageText(messages[i]);
    if (isCompleteParallaxResponse(text)) return text;
  }
  return '';
}

async function recoverAcceptedTurn({ msgId, text, expectUrl }) {
  if (!msgId || recoveringTurn?.msgId === msgId) return;
  if (recoveringTurn) recoveringTurn.cancelled = true;
  const mismatch = conversationMismatch(expectUrl);
  if (mismatch) {
    postToBg({
      type: 'wrong_conversation',
      msgId,
      expected: mismatch.expected,
      actual: mismatch.actual,
    });
    return;
  }

  const recovery = { msgId, cancelled: false };
  recoveringTurn = recovery;
  const startedAt = Date.now();
  wlog(`recovering accepted turn msgId=${msgId} from the rendered conversation`);
  try {
    while (!recovery.cancelled && Date.now() - startedAt < 180000) {
      const response = completedResponseAfterPrompt(text);
      if (response) {
        wlog(`recovered response → post ${prev(response)} url=${window.location.href}`);
        postToBg({
          type: 'response',
          source: 'page-recovery',
          text: response,
          toolCalls: '',
          msgId,
          url: window.location.href,
        });
        return;
      }
      await sleep(500);
    }
    if (!recovery.cancelled) {
      postToBg({
        type: 'error',
        source: 'page-recovery',
        message: 'The accepted response could not be recovered after the page reconnected.',
        msgId,
        url: window.location.href,
      });
    }
  } finally {
    if (recoveringTurn === recovery) recoveringTurn = null;
  }
}

function editableUserTurns() {
  return [...document.querySelectorAll('[data-message-author-role="user"]')]
    .filter((element) => element.getBoundingClientRect().height > 0);
}

function editButtonForTurn(turn) {
  const region =
    turn.closest('article,[data-testid^="conversation-turn-"]') ||
    turn.parentElement ||
    turn;
  try {
    region.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    region.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
  } catch (_) {}
  return [...region.querySelectorAll('button')].find((button) => {
    const label = `${button.getAttribute('aria-label') || ''} ${button.title || ''}`;
    return /\bedit(?: message)?\b/i.test(label);
  }) || null;
}

function inlineMessageEditor() {
  const composer = find(SELECTORS.input);
  return [...document.querySelectorAll('textarea,[contenteditable="true"][role="textbox"],[contenteditable="true"]')]
    .find((element) => {
      if (element === composer || element.id === 'prompt-textarea') return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }) || null;
}

function inlineEditSubmit(editor) {
  let region = editor.parentElement;
  for (let depth = 0; region && depth < 7; depth++, region = region.parentElement) {
    const button = [...region.querySelectorAll(':scope button')].find((candidate) => {
      if (candidate.disabled || candidate.getAttribute('aria-disabled') === 'true') return false;
      const label = compactMessageText(
        `${candidate.getAttribute('aria-label') || ''} ${candidate.textContent || ''}`,
      );
      return /^send(?: message)?$/i.test(label);
    });
    if (button) return button;
  }
  return null;
}

async function editMessageInChatGPT(text, msgId, originalText, userIndex, expectUrl) {
  const mismatch = conversationMismatch(expectUrl);
  if (mismatch) {
    postToBg({
      type: 'wrong_conversation',
      msgId,
      expected: mismatch.expected,
      actual: mismatch.actual,
    });
    return;
  }
  if (sending) {
    postToBg({
      type: 'error',
      message: 'Wait for the current response to finish before editing a message.',
      msgId,
      url: window.location.href,
    });
    return;
  }

  wlog(`edit_message START msgId=${msgId} userIndex=${userIndex} ${prev(text)}`);
  sending = true;
  currentSend = {
    msgId,
    resolved: false,
    gotNet: false,
    resolve: null,
    requestStarted: false,
    requestResolve: null,
    armReady: false,
    armResolve: null,
    armTimer: null,
    convKey: conversationId(expectUrl),
    expectUrl,
  };
  resetStream();
  const netDone = new Promise((resolve) => { currentSend.resolve = resolve; });

  try {
    if (!(await armNetHooks(true, msgId))) {
      throw new Error('The network response hook did not become ready.');
    }
    const target = await waitForDom(() => {
      const turns = editableUserTurns();
      const indexed = Number.isInteger(userIndex) ? turns[userIndex] : null;
      if (
        indexed &&
        (!originalText ||
          compactMessageText(indexed.textContent).includes(compactMessageText(originalText)))
      ) {
        return indexed;
      }
      const expected = compactMessageText(originalText);
      return expected
        ? turns.find((turn) => compactMessageText(turn.textContent).includes(expected)) || null
        : null;
    }, 30000);
    if (!target) throw new Error('Could not find the message to edit in ChatGPT.');

    const editButton = await waitForDom(() => editButtonForTurn(target), 5000);
    if (!editButton) throw new Error('ChatGPT did not expose the message edit control.');
    realClick(editButton);

    const editor = await waitForDom(() => inlineMessageEditor(), 10000);
    if (!editor) throw new Error('ChatGPT did not open the message editor.');
    const inserted = setComposerText(editor, text);
    if (!sameComposerText(inserted, text)) {
      throw new Error('ChatGPT did not accept the edited message text.');
    }

    const submit = await waitForDom(() => inlineEditSubmit(editor), 10000);
    if (!submit) throw new Error('ChatGPT did not enable the edited message.');
    realClick(submit);

    const accepted = await Promise.race([
      new Promise((resolve) => {
        if (currentSend?.requestStarted) resolve(true);
        else if (currentSend) currentSend.requestResolve = resolve;
        else resolve(false);
      }),
      sleep(8000).then(() => false),
    ]);
    if (!accepted) {
      if (currentSend) currentSend.requestResolve = null;
      throw new Error('ChatGPT did not accept the edited message.');
    }

    postToBg({ type: 'sent', msgId, url: window.location.href });
    const outcome = await Promise.race([
      netDone.then(() => ({ kind: 'net' })),
      sleep(180000).then(() => ({ kind: 'timeout' })),
    ]);
    if (!currentSend.resolved && outcome.kind === 'timeout') {
      currentSend.resolved = true;
      postToBg({
        type: 'transport_metric',
        msgId,
        source: 'network',
        status: 'timeout',
        chars: 0,
        domFallbacks: 0,
        durationMs: 180000,
        url: window.location.href,
      });
      postToBg({
        type: 'error',
        source: 'network',
        message: 'The network response timed out.',
        msgId,
        url: window.location.href,
      });
    }
  } catch (error) {
    if (!currentSend || !currentSend.resolved) {
      postToBg({
        type: 'error',
        message: error?.message || 'Could not edit the message.',
        msgId,
        url: window.location.href,
      });
    }
  } finally {
    sending = false;
    currentSend = null;
    void armNetHooks(false, msgId);
    if (pendingSend) {
      const next = pendingSend;
      pendingSend = null;
      sendMessageToChatGPT(next.text, next.msgId, next.model, next.intelligence, next.expectUrl);
    }
  }
}

async function handleSendFiles(files) {
  const fileInput = find(SELECTORS.fileUpload);
  if (!fileInput || fileInput.tagName !== 'INPUT') {
    const paperclip = find(SELECTORS.fileUpload);
    if (paperclip) {
      paperclip.click();
      await sleep(500);
    }
  }

  const input = document.querySelector('input[type="file"]');
  if (!input) {
    postToBg({ type: 'error', message: 'No file upload input found', url: window.location.href });
    throw new Error('No file upload input found');
  }

  const dt = new DataTransfer();
  for (const f of files) {
    const response2 = await fetch(f.data);
    const blob = await response2.blob();
    const file = new File([blob], f.name, { type: f.mime || blob.type });
    dt.items.add(file);
  }
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));

  await sleep(500);
  postToBg({ type: 'ready', url: window.location.href });
}

function handleDebug(msg) {
  try {
    if (msg.action === 'dom') {
      const inputEl = find(SELECTORS.input);
      const sendBtn = find(SELECTORS.sendButton);
      const stopBtn = find(SELECTORS.stopButton);

      const snippet = [];
      snippet.push('=== INPUT AREA ===');
      snippet.push(inputEl?.outerHTML?.slice(0, 2000) || 'NOT FOUND');
      snippet.push('');

      const inputParent = inputEl?.closest('form, div, section');
      if (inputParent) {
        snippet.push('=== INPUT PARENT (' + inputParent.tagName + ') ===');
        snippet.push(inputParent.outerHTML.slice(0, 3000));
        snippet.push('');
      }

      snippet.push('=== SEND BUTTON ===');
      snippet.push(sendBtn?.outerHTML?.slice(0, 1000) || 'NOT FOUND');
      snippet.push('');

      snippet.push('=== STOP BUTTON ===');
      snippet.push(stopBtn?.outerHTML?.slice(0, 1000) || 'NOT FOUND');
      snippet.push('');

      snippet.push('=== ALL BUTTONS (first 15) ===');
      document.querySelectorAll('button').forEach((b, i) => {
        if (i >= 15) return;
        const rect = b.getBoundingClientRect();
        snippet.push(
          `${i}: <${b.tagName}` +
          ` id="${b.id}"` +
          ` data-testid="${b.getAttribute('data-testid') || ''}"` +
          ` aria-label="${(b.getAttribute('aria-label') || '').slice(0, 40)}"` +
          ` disabled=${b.disabled}` +
          ` visible=${rect.width > 0 && rect.height > 0}` +
          ` rect=${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}` +
          ` text="${(b.textContent || '').trim().slice(0, 30)}"`
        );
      });
      snippet.push('');

      const chatLog = document.querySelector('[class*="conversation"], [role="log"], main, [class*="chat"]');
      snippet.push('=== CHAT CONTAINER ===');
      snippet.push(chatLog?.outerHTML?.slice(0, 2000) || 'NOT FOUND');

      postToBg({
        type: 'debug_result',
        action: 'dom',
        data: {
          url: window.location.href,
          selectors: testSelectors(),
          html: snippet.join('\n'),
        },
      });
    }
  } catch (err) {
    postToBg({
      type: 'debug_result',
      action: 'dom',
      data: { html: 'ERROR in handleDebug:\n' + (err?.stack || err?.message || err) },
    });
  }
}

function postToBg(msg) {
  if (backgroundPort) {
    try {
      backgroundPort.postMessage(msg);
    } catch (e) {
      console.error('[Parallax] postToBg failed:', e);
      if (pendingOutbox.length < 100) pendingOutbox.push(msg);
    }
  } else {
    if (pendingOutbox.length < 100) pendingOutbox.push(msg);
  }
}

// Relay a trace line to the desktop's terminal (via background → WebSocket → main),
// AND log locally. So the ChatGPT-page side of the flow shows up in the SAME
// stream as the renderer/main/extension events — always on. Never queued: a log
// line isn't worth buffering if the port is momentarily down.
function wlog(msg, extra) {
  try { if (backgroundPort) backgroundPort.postMessage({ type: 'log', msg, extra }); } catch (_) {}
  if (extra !== undefined) console.log('[Parallax]', msg, extra); else console.log('[Parallax]', msg);
}
function prev(s, n = 60) {
  if (!s) return '∅';
  const one = String(s).replace(/\s+/g, ' ').trim();
  return `len=${String(s).length} "${one.slice(0, n)}${one.length > n ? '…' : ''}"`;
}

function showReloadWarning() {
  const existing = document.getElementById('__parallax_reload_warning');
  if (existing) return;
  const banner = document.createElement('div');
  banner.id = '__parallax_reload_warning';
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#dc2626;color:#fff;text-align:center;padding:8px 16px;font:13px/1.4 -apple-system,sans-serif;cursor:pointer';
  banner.textContent = '⚠ Parallax extension was reloaded — click to refresh this page';
  banner.onclick = () => location.reload();
  document.body.prepend(banner);
  // Also try to auto-reload after 30s
  setTimeout(() => { if (document.getElementById('__parallax_reload_warning')) location.reload(); }, 30000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', connectBackground);
} else {
  connectBackground();
}
