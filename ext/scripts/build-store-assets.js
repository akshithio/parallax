const { spawn } = require('node:child_process');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');

const workspaceRoot = path.join(__dirname, '..', '..');
const outputDirectory = path.join(__dirname, '..', 'store', 'assets');
const appUrl = 'http://127.0.0.1:3100';

async function waitForApp() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(appUrl);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Parallax preview did not become ready within one minute.');
}

async function installPreviewBridge(page) {
  await page.addInitScript(() => {
    const listeners = new Map();
    const subscribe = (event) => (handler) => {
      const handlers = listeners.get(event) || new Set();
      handlers.add(handler);
      listeners.set(event, handlers);
      return () => handlers.delete(handler);
    };
    const conversation = {
      id: 'store-preview',
      title: 'Release readiness',
      folderPath: '/Users/akshith/Developer/Projects/parallax',
      chatgptUrl: 'https://chatgpt.com/c/store-preview',
      updatedAt: Date.now(),
      messages: [
        { role: 'user', text: 'Check the extension release path and summarize what is ready.' },
        {
          role: 'assistant',
          text: 'The manifest, package, privacy disclosure, and release checks are aligned. The store submission remains a deliberate final step.',
        },
      ],
    };
    const emit = (event, payload) => {
      for (const handler of listeners.get(event) || []) handler(payload);
    };
    localStorage.setItem('parallax:permission', 'full-access');
    localStorage.setItem('parallax:theme', 'light');
    window.parallax = {
      loadData: async () => ({
        ok: true,
        data: {
          conversations: { [conversation.id]: conversation },
          convOrder: [conversation.id],
          projects: [conversation.folderPath],
        },
      }),
      saveData: async () => ({ ok: true }),
      send() {},
      editMessage() {},
      agentExec: async ({ actions }) => ({
        results: actions.map(() => ({ status: 'ok', content: 'completed' })),
      }),
      ready() {
        queueMicrotask(() => {
          emit('status', { type: 'ws', status: 'connected' });
          emit('status', {
            type: 'chatgpt',
            status: 'ready',
            convId: conversation.id,
            url: conversation.chatgptUrl,
          });
        });
      },
      log() {},
      sendFiles() {},
      navigate() {},
      newChat() {},
      switchModel() {},
      stopGenerating() {},
      selectFolder: async () => ({ ok: false }),
      detectEditors: async () => ({ available: [], default: null }),
      onStatus: subscribe('status'),
      onSent: subscribe('sent'),
      onModels: subscribe('models'),
      onSelectionError: subscribe('selection_error'),
      onStreamUpdate: subscribe('stream_update'),
      onResponse: subscribe('response'),
      onError: subscribe('error'),
      onWrongConversation: subscribe('wrong_conversation'),
      onDebugResult: subscribe('debug_result'),
      onAgentExecProgress: subscribe('agent_exec_progress'),
    };
  });
}

async function buildAssets() {
  mkdirSync(outputDirectory, { recursive: true });
  const server = spawn('pnpm', ['--filter', '@parallax/app', 'run', 'dev:web'], {
    cwd: workspaceRoot,
    env: process.env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let serverError = '';
  server.stderr.on('data', (chunk) => { serverError += chunk; });
  const serverStopped = new Promise((_, reject) => {
    server.once('exit', (code) => {
      reject(new Error(serverError || `Parallax preview exited with code ${code}.`));
    });
  });

  let browser = null;
  try {
    await Promise.race([waitForApp(), serverStopped]);
    browser = await chromium.launch();

    const appPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await installPreviewBridge(appPage);
    await appPage.goto(appUrl, { waitUntil: 'domcontentloaded' });
    await appPage.locator('[data-main-panel]').waitFor();
    await appPage.screenshot({
      path: path.join(outputDirectory, 'parallax-workspace-1280x800.png'),
      animations: 'disabled',
    });

    const promoPage = await browser.newPage({ viewport: { width: 440, height: 280 } });
    await promoPage.setContent(`
      <!doctype html>
      <html>
        <style>
          * { box-sizing: border-box; }
          html, body { width: 440px; height: 280px; margin: 0; overflow: hidden; }
          body { display: grid; place-items: center; background: #4739d7; color: white; }
          svg { width: 142px; height: 142px; }
        </style>
        <body>
          <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-linecap="round">
            <path d="M32 4v56" stroke-width="7" opacity="0.34"/>
            <path d="M10 10 32 32 54 32" stroke-width="10"/>
            <path d="M32 32 54 54" stroke-width="10" opacity="0.3"/>
          </svg>
        </body>
      </html>
    `);
    await promoPage.screenshot({
      path: path.join(outputDirectory, 'parallax-promo-440x280.png'),
      animations: 'disabled',
    });
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
  }

  if (serverError && !server.killed) throw new Error(serverError);
  console.log(outputDirectory);
}

buildAssets().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
