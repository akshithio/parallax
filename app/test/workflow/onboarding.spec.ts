import { expect, test } from '@playwright/test'

declare global {
  interface Window {
    __onboardingHarness: {
      opened: string[]
      sends: Array<{ text: string; wireText?: string; convId?: string }>
    }
  }
}

test('connects the extension, selects a folder, and sends the first real message', async ({ page }) => {
  await page.addInitScript(() => {
    const listeners = new Map<string, Set<(payload: unknown) => void>>()
    const subscribe = (event: string) => (handler: (payload: unknown) => void) => {
      const handlers = listeners.get(event) || new Set()
      handlers.add(handler)
      listeners.set(event, handlers)
      return () => handlers.delete(handler)
    }
    const harness = {
      opened: [] as string[],
      sends: [] as Array<{ text: string; wireText?: string; convId?: string }>,
    }
    window.__onboardingHarness = harness
    window.parallax = {
      loadData: async () => ({
        ok: true,
        data: { conversations: {}, convOrder: [], projects: [] },
      }),
      saveData: async () => ({ ok: true }),
      selectFolder: async () => ({ ok: true, path: '/tmp/first-project' }),
      previewOpenExternal: async (url: string) => {
        harness.opened.push(url)
        return { ok: true }
      },
      send(
        text: string,
        _model: string | undefined,
        _intelligence: string | undefined,
        wireText: string | undefined,
        _silent: boolean,
        _expectUrl: string | undefined,
        convId: string | undefined,
      ) {
        harness.sends.push({ text, wireText, convId })
      },
      agentExec: async () => ({ results: [{ status: 'ok', content: '' }] }),
      detectEditors: async () => ({ available: [], default: null }),
      ready() {
        queueMicrotask(() => {
          for (const handler of listeners.get('status') || []) {
            handler({ type: 'server', status: 'listening', port: 8765 })
            handler({ type: 'ws', status: 'connected' })
          }
        })
      },
      log() {},
      sendFiles() {},
      navigate() {},
      newChat() {},
      switchModel() {},
      stopGenerating() {},
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
    }
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Your repository, one conversation away.' })).toBeVisible()
  await page.getByRole('button', { name: 'Get started' }).click()

  await expect(page.getByText('Extension connected')).toBeVisible()
  await page.getByRole('button', { name: 'Open Chrome Web Store' }).click()
  await expect.poll(() => page.evaluate(() => window.__onboardingHarness.opened[0])).toBe(
    'https://chromewebstore.google.com/detail/parallax/bfnlhalnojbjoipblfnhhljffajanaei?authuser=0&hl=en-GB',
  )

  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Choose a project folder' }).click()
  await expect(page.getByRole('heading', { name: 'Send your first message' })).toBeVisible()
  await expect(page.getByText('first-project')).toBeVisible()

  const message = 'Explain how this repository is structured.'
  await page.getByRole('textbox', { name: 'First message' }).fill(message)
  await expect(page.getByRole('button', { name: 'Send first message' })).toBeEnabled()
  await page.getByRole('button', { name: 'Send first message' }).click()

  await expect.poll(() => page.evaluate(() => window.__onboardingHarness.sends[0]?.text)).toBe(message)
  await expect.poll(() => page.evaluate(() => localStorage.getItem('parallax:onboarding:v1'))).toBe('complete')
  await expect(page.getByText(message)).toBeVisible()
})
