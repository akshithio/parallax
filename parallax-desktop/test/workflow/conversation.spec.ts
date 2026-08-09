import { expect, test, type Locator, type Page } from '@playwright/test'

declare global {
  interface Window {
    __parallaxHarness: {
      sends: Array<{
        text: string
        wireText?: string
        silent: boolean
        convId?: string
        msgId?: string
      }>
      executions: Array<{ actions: Array<Record<string, unknown>> }>
      emit: (event: string, payload: unknown) => void
    }
  }
}

const CONV_ID = 'workflow-thread'
const CHAT_URL = 'https://chatgpt.com/c/cccccccc-cccc-cccc-cccc-cccccccccccc'

async function emit(page: Page, event: string, payload: unknown) {
  await page.evaluate(
    ({ eventName, eventPayload }) => {
      window.__parallaxHarness.emit(eventName, eventPayload)
    },
    { eventName: event, eventPayload: payload },
  )
}

async function transcriptMetrics(locator: Locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      minHeight: style.minHeight,
    }
  })
}

async function contrastAgainstPage(
  locator: Locator,
  property: 'color' | 'borderLeftColor' = 'color',
) {
  return locator.evaluate((element, propertyName) => {
    const parse = (value: string) => {
      const channels = value.match(/[\d.]+/g)?.map(Number)
      if (!channels || channels.length < 3) throw new Error(`Unsupported color: ${value}`)
      return {
        red: channels[0],
        green: channels[1],
        blue: channels[2],
        alpha: channels[3] ?? 1,
      }
    }
    const luminance = (red: number, green: number, blue: number) => {
      const linear = [red, green, blue].map((channel) => {
        const normalized = channel / 255
        return normalized <= 0.04045
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
    }

    const style = getComputedStyle(element)
    const cssProperty = propertyName.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
    const foregroundValue = style.getPropertyValue(cssProperty)
    const backgroundValue = getComputedStyle(document.documentElement).backgroundColor
    const foreground = parse(foregroundValue)
    const background = parse(backgroundValue)
    const red = foreground.red * foreground.alpha + background.red * (1 - foreground.alpha)
    const green = foreground.green * foreground.alpha + background.green * (1 - foreground.alpha)
    const blue = foreground.blue * foreground.alpha + background.blue * (1 - foreground.alpha)
    const foregroundLuminance = luminance(red, green, blue)
    const backgroundLuminance = luminance(background.red, background.green, background.blue)
    return {
      foreground: foregroundValue,
      background: backgroundValue,
      ratio:
        (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
        (Math.min(foregroundLuminance, backgroundLuminance) + 0.05),
    }
  }, property)
}

test('runs a naturally ordered two-round repository workflow', async ({ page }) => {
  await page.addInitScript(
    ({ convId, chatUrl }) => {
      const listeners = new Map<string, Set<(payload: unknown) => void>>()
      const subscribe = (event: string) => (handler: (payload: unknown) => void) => {
        const handlers = listeners.get(event) || new Set()
        handlers.add(handler)
        listeners.set(event, handlers)
        return () => handlers.delete(handler)
      }
      const harness = {
        sends: [] as Array<{
          text: string
          wireText?: string
          silent: boolean
          convId?: string
          msgId?: string
        }>,
        executions: [] as Array<{ actions: Array<Record<string, unknown>> }>,
        emit(event: string, payload: unknown) {
          for (const handler of listeners.get(event) || []) handler(payload)
        },
      }

      window.__parallaxHarness = harness
      localStorage.setItem('parallax:permission', 'full-access')
      localStorage.setItem('parallax:theme', 'light')
      window.parallax = {
        loadData: async () => ({
          ok: true,
          data: {
            conversations: {
              [convId]: {
                id: convId,
                title: 'Workflow test',
                messages: [],
                chatgptUrl: chatUrl,
                folderPath: '/tmp/workflow-project',
                updatedAt: 1,
              },
            },
            convOrder: [convId],
            projects: ['/tmp/workflow-project'],
          },
        }),
        saveData: async () => ({ ok: true }),
        send(
          text: string,
          _model: string | undefined,
          _intelligence: string | undefined,
          wireText: string | undefined,
          silent: boolean,
          _expectUrl: string | undefined,
          outgoingConvId: string | undefined,
          msgId: string | undefined,
        ) {
          harness.sends.push({ text, wireText, silent: Boolean(silent), convId: outgoingConvId, msgId })
        },
        agentExec: async ({ actions }: { actions: Array<Record<string, unknown>> }) => {
          harness.executions.push({ actions })
          return {
            results: actions.map((action) => ({
              status: 'ok',
              content:
                action.type === 'read'
                  ? '{"name":"workflow-project"}'
                  : action.type === 'list'
                    ? 'MessageLog.tsx\nInputBar.tsx'
                    : action.command === 'ls -la'
                      ? Array.from(
                          { length: 180 },
                          (_, index) => `-rw-r--r--  1 user  staff  ${index + 1} file-${index + 1}.txt`,
                        ).join('\n')
                    : `completed ${String(action.command || action.type)}`,
            })),
          }
        },
        ready() {
          queueMicrotask(() => {
            harness.emit('status', { type: 'ws', status: 'connected' })
            harness.emit('status', {
              type: 'chatgpt',
              status: 'ready',
              convId,
              url: chatUrl,
            })
          })
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
      }
    },
    { convId: CONV_ID, chatUrl: CHAT_URL },
  )

  await page.goto('/')
  const panelFont = await page.locator('[data-main-panel]').evaluate(
    (element) => getComputedStyle(element).fontFamily,
  )
  expect(panelFont).toContain('-apple-system')

  const collapseSidebar = page.getByRole('button', { name: 'Collapse sidebar' })
  const collapseBox = await collapseSidebar.boundingBox()
  expect(collapseBox).not.toBeNull()
  await collapseSidebar.click()
  const expandSidebar = page.locator('[data-sidebar-expand]')
  await expect(expandSidebar).toBeVisible()
  const [expandBox, titleBox] = await Promise.all([
    expandSidebar.boundingBox(),
    page.locator('[data-thread-title]').boundingBox(),
  ])
  expect(expandBox).not.toBeNull()
  expect(titleBox).not.toBeNull()
  expect(expandBox!.x).toBe(collapseBox!.x)
  expect(expandBox!.y).toBe(collapseBox!.y)
  expect(titleBox!.x).toBeGreaterThanOrEqual(expandBox!.x + expandBox!.width + 8)
  await expandSidebar.click()

  const prompt = 'Explain how this repository handles messages.'
  const composer = page.getByRole('textbox')
  await expect(composer).toBeVisible()
  await composer.fill(prompt)
  await page.getByRole('button', { name: 'Send message' }).click()

  await expect(page.getByText(prompt, { exact: true })).toHaveCount(1)
  const userBubbleMetrics = await page.locator('[data-user-message]').evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      paddingBlock: `${style.paddingTop} ${style.paddingBottom}`,
      paddingInline: `${style.paddingLeft} ${style.paddingRight}`,
      borderRadius: style.borderRadius,
    }
  })
  expect(userBubbleMetrics).toEqual({
    paddingBlock: '6px 6px',
    paddingInline: '10px 10px',
    borderRadius: '14px',
  })
  await expect(page.locator('[data-delivery="pending"]')).toHaveCount(1)
  await expect(page.getByLabel('Thinking')).toBeVisible()
  await expect(page.locator('.parallax-thinking-enter')).toHaveCSS('transform', 'none')
  const thinkingAnimation = await page.locator('.parallax-thinking-pulse').evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      name: style.animationName,
      duration: style.animationDuration,
      iterations: style.animationIterationCount,
    }
  })
  expect(thinkingAnimation).toEqual({
    name: 'parallax-thinking-pulse',
    duration: '1.5s',
    iterations: 'infinite',
  })
  const shimmerAnimation = await page.locator('[aria-label="Thinking"] .parallax-shimmer').evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      name: style.animationName,
      duration: style.animationDuration,
      iterations: style.animationIterationCount,
      backgroundSize: style.backgroundSize,
      backgroundRepeat: style.backgroundRepeat,
    }
  })
  expect(shimmerAnimation).toEqual({
    name: 'parallax-shimmer',
    duration: '1.35s',
    iterations: 'infinite',
    backgroundSize: '70% 100%',
    backgroundRepeat: 'no-repeat',
  })
  const thinkingMetrics = await transcriptMetrics(
    page.locator('[data-activity-row="thinking"]'),
  )
  expect(thinkingMetrics).toEqual({
    fontSize: '14px',
    lineHeight: '24px',
    minHeight: '32px',
  })
  const thinkingLabelMetrics = await page.locator('.parallax-thinking-pulse').evaluate((element) => {
    const box = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return { left: box.left, top: box.top, fontWeight: style.fontWeight }
  })
  await expect
    .poll(() =>
      page.evaluate(() => window.__parallaxHarness.sends.filter((send) => !send.silent).length),
    )
    .toBe(1)
  const firstSend = await page.evaluate(() =>
    window.__parallaxHarness.sends.find((send) => !send.silent),
  )
  await emit(page, 'sent', {
    text: prompt,
    msgId: firstSend?.msgId,
    convId: CONV_ID,
    url: CHAT_URL,
  })
  await expect(page.locator('[data-delivery="sent"]')).toHaveCount(1)
  await expect(page.getByLabel('Thinking')).toBeVisible()
  await page.waitForTimeout(1100)
  const settledThinkingLabel = await page.locator('.parallax-thinking-pulse').boundingBox()
  expect(settledThinkingLabel).not.toBeNull()
  expect(Math.abs(settledThinkingLabel!.y - thinkingLabelMetrics.top)).toBeLessThanOrEqual(0.5)

  const firstActionTurn =
    '{plx:note}Reading the repository structure{/plx:note}\n' +
    '{plx:run}pwd{/plx:run}\n' +
    '{plx:run}ls -la{/plx:run}'
  const executionsBeforeActionStream = await page.evaluate(
    () => window.__parallaxHarness.executions.length,
  )
  await emit(page, 'stream_update', {
    convId: CONV_ID,
    url: CHAT_URL,
    text: firstActionTurn,
  })

  const structurePhase = page.getByRole('button', { name: 'Reading the repository structure' })
  await expect(structurePhase).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByLabel('Thinking')).toHaveCount(0)
  await expect(page.getByText('pwd', { exact: true })).toHaveCount(0)
  await structurePhase.click()
  await expect(page.getByText('pwd', { exact: true })).toBeVisible()
  await expect(page.getByText('ls -la', { exact: true })).toBeVisible()
  await expect(page.getByText('run pwd', { exact: true })).toHaveCount(0)
  await expect(page.locator('[data-tool-kind="run"] [data-activity-icon]').first()).toHaveAttribute(
    'title',
    'Shell command',
  )
  await expect(
    page.locator('[data-activity-row="tool"] [data-tool-status="running"]'),
  ).toHaveCount(2)
  expect(await page.evaluate(() => window.__parallaxHarness.executions.length)).toBe(
    executionsBeforeActionStream,
  )
  await structurePhase.click()

  await emit(page, 'response', {
    convId: CONV_ID,
    url: CHAT_URL,
    text: firstActionTurn,
  })

  await structurePhase.click()
  await expect(page.getByText('pwd', { exact: true })).toBeVisible()
  await expect(page.getByText('ls -la', { exact: true })).toBeVisible()
  await expect(page.locator('html')).not.toHaveClass(/dark/)
  const phaseMetrics = await transcriptMetrics(
    page.locator('[data-activity-row="phase"]').first(),
  )
  const toolMetrics = await transcriptMetrics(
    page.locator('[data-activity-row="tool"]').first(),
  )
  expect(phaseMetrics).toEqual(thinkingMetrics)
  expect(toolMetrics).toEqual(thinkingMetrics)
  const phaseTitleMetrics = await structurePhase.locator('.parallax-phase-title').evaluate((element) => {
    const box = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return { left: box.left, fontWeight: style.fontWeight }
  })
  expect(Math.abs(phaseTitleMetrics.left - thinkingLabelMetrics.left)).toBeLessThanOrEqual(1)
  expect(phaseTitleMetrics.fontWeight).toBe(thinkingLabelMetrics.fontWeight)
  const iconContrast = await contrastAgainstPage(page.locator('[data-activity-icon]').first())
  const disclosureContrast = await contrastAgainstPage(
    page.locator('[data-activity-disclosure]').first(),
  )
  const ruleContrast = await contrastAgainstPage(
    page.locator('[data-activity-rule]').first(),
    'borderLeftColor',
  )
  expect(iconContrast.ratio).toBeGreaterThanOrEqual(5.5)
  expect(disclosureContrast.ratio).toBeGreaterThanOrEqual(4.5)
  expect(ruleContrast.ratio).toBeGreaterThanOrEqual(1.45)
  const pwdCommand = page.getByRole('button', { name: 'Shell command: pwd' })
  await pwdCommand.click()
  await expect(page.getByText('completed pwd', { exact: true })).toBeVisible()
  await expect(page.locator('[data-tool-disclosure]').first()).toHaveCSS('display', 'block')
  const outputContrast = await contrastAgainstPage(page.locator('[data-tool-result]').first())
  const statusContrast = await contrastAgainstPage(page.locator('[data-tool-status="ok"]').first())
  expect(outputContrast.ratio).toBeGreaterThanOrEqual(10)
  expect(statusContrast.ratio).toBeGreaterThanOrEqual(4.5)
  const outputSurfaceColors = await page.locator('[data-activity-rule]').first().evaluate((element) => ({
    surface: getComputedStyle(element).backgroundColor,
    page: getComputedStyle(document.body).backgroundColor,
  }))
  expect(outputSurfaceColors.surface).not.toBe(outputSurfaceColors.page)
  const lsCommand = page.getByRole('button', { name: 'Shell command: ls -la' })
  await lsCommand.click()
  await expect(page.locator('[data-tool-result]').last()).toContainText('file-180.txt')
  await page.locator('[data-tool-disclosure]').last().evaluate((element) => {
    const disclosure = element as HTMLElement
    disclosure.style.maxHeight = 'none'
    disclosure.style.height = '1200px'
  })
  const transcriptScroller = page.locator('[data-parallax-transcript]')
  await transcriptScroller.evaluate((element) => {
    element.scrollTop = 0
    element.dispatchEvent(new Event('scroll'))
  })
  await expect(page.getByRole('button', { name: 'Scroll to end' })).toBeVisible()
  await structurePhase.click()
  await expect(page.getByRole('button', { name: 'Scroll to end' })).toHaveCount(0)
  await expect
    .poll(() =>
      page.evaluate(() => window.__parallaxHarness.sends.filter((send) => send.silent).length),
    )
    .toBe(1)

  await emit(page, 'response', {
    convId: CONV_ID,
    url: CHAT_URL,
    text:
      '{plx:note}Tracing message delivery{/plx:note}\n' +
      '{plx:read path="package.json" /}\n' +
      '{plx:list path="components" /}',
  })

  const deliveryPhase = page.getByRole('button', {
    name: 'Tracing message delivery',
  })
  await expect(deliveryPhase).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByLabel('Thinking')).toHaveCount(0)
  await expect(page.locator('[data-activity-stream]')).toHaveCount(1)
  await expect(page.locator('[data-activity-phase]')).toHaveCount(2)
  await expect
    .poll(() =>
      page.evaluate(() => window.__parallaxHarness.sends.filter((send) => send.silent).length),
    )
    .toBe(2)

  await emit(page, 'response', {
    convId: CONV_ID,
    url: CHAT_URL,
    text:
      '{plx:done}The desktop routes each task through its own browser conversation and renders action rounds as an ordered transcript.{/plx:done}',
  })

  const finalAnswer =
    'The desktop routes each task through its own browser conversation and renders action rounds as an ordered transcript.'
  await expect(page.getByText(finalAnswer)).toBeVisible()
  const answerMetrics = await transcriptMetrics(
    page.locator('.parallax-transcript-copy').filter({ hasText: finalAnswer }),
  )
  expect(answerMetrics.fontSize).toBe(thinkingMetrics.fontSize)
  expect(answerMetrics.lineHeight).toBe(thinkingMetrics.lineHeight)
  const answerCopy = page.locator('.parallax-transcript-copy').filter({ hasText: finalAnswer })
  const answerCopyMetrics = await answerCopy.evaluate((element) => {
    const box = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return { left: box.left, top: box.top, fontWeight: style.fontWeight }
  })
  expect(Math.abs(answerCopyMetrics.left - thinkingLabelMetrics.left)).toBeLessThanOrEqual(1)
  expect(answerCopyMetrics.fontWeight).toBe(thinkingLabelMetrics.fontWeight)
  const activityBottom = await page.locator('[data-activity-stream]').evaluate((element) =>
    element.getBoundingClientRect().bottom,
  )
  expect(answerCopyMetrics.top - activityBottom).toBeLessThanOrEqual(16)
  await expect(page.getByText(prompt, { exact: true })).toHaveCount(1)
  await expect(page.getByText(/Ran \d+ tools/i)).toHaveCount(0)
  await expect(page.getByText(/Command details/i)).toHaveCount(0)
  await expect(page.getByText(/can't parse/i)).toHaveCount(0)

  const visibleTranscript = await page.locator('body').innerText()
  expect(visibleTranscript.indexOf('Reading the repository structure')).toBeLessThan(
    visibleTranscript.indexOf('Tracing message delivery'),
  )
  expect(visibleTranscript.indexOf('Tracing message delivery')).toBeLessThan(
    visibleTranscript.indexOf(finalAnswer),
  )
  const workflowExecutions = await page.evaluate(() =>
    window.__parallaxHarness.executions.slice(-4).map((batch) =>
      batch.actions.map((action) => ({
        type: action.type,
        command: action.command,
        path: action.path,
      })),
    ),
  )
  expect(workflowExecutions).toEqual([
    [
      { type: 'run', command: 'pwd', path: undefined },
    ],
    [
      { type: 'run', command: 'ls -la', path: undefined },
    ],
    [
      { type: 'read', command: undefined, path: 'package.json' },
    ],
    [
      { type: 'list', command: undefined, path: 'components' },
    ],
  ])

  const greeting = 'hello again'
  await composer.fill(greeting)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect
    .poll(() =>
      page.evaluate(() => window.__parallaxHarness.sends.filter((send) => !send.silent).length),
    )
    .toBe(2)
  const greetingSend = await page.evaluate(() =>
    window.__parallaxHarness.sends.filter((send) => !send.silent).at(-1),
  )
  await emit(page, 'sent', {
    text: greeting,
    msgId: greetingSend?.msgId,
    convId: CONV_ID,
    url: CHAT_URL,
  })
  await emit(page, 'stream_update', {
    convId: CONV_ID,
    text: 'Hello **there** — this is still streaming.',
  })
  await expect(page.locator('[data-streaming-copy]')).toContainText(
    'Hello there — this is still streaming.',
  )
  await expect(page.locator('[data-streaming-copy] strong')).toHaveText('there')
  await emit(page, 'response', {
    convId: CONV_ID,
    url: CHAT_URL,
    text: 'Hello **there** — this is complete.',
  })
  await expect(page.locator('[data-streaming-copy]')).toHaveCount(0)

  await page.getByRole('button', { name: 'Full access' }).click()
  await page.getByRole('button', { name: 'Manual' }).click()
  await expect(page.getByRole('button', { name: 'Manual' })).toBeVisible()
  const normalComposerBox = await page.locator('.chat-composer-glass').boundingBox()
  expect(normalComposerBox).not.toBeNull()

  const manualPrompt = 'List the workspace files.'
  await composer.fill(manualPrompt)
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect
    .poll(() =>
      page.evaluate(() => window.__parallaxHarness.sends.filter((send) => !send.silent).length),
    )
    .toBe(3)
  const manualSend = await page.evaluate(() =>
    window.__parallaxHarness.sends.filter((send) => !send.silent).at(-1),
  )
  await emit(page, 'sent', {
    text: manualPrompt,
    msgId: manualSend?.msgId,
    convId: CONV_ID,
    url: CHAT_URL,
  })
  const executionCountBeforeManualResponse = await page.evaluate(
    () => window.__parallaxHarness.executions.length,
  )
  await emit(page, 'response', {
    convId: CONV_ID,
    url: CHAT_URL,
    text:
      '{plx:note}Reading the repository structure{/plx:note}\n' +
      '{plx:run}ls -la{/plx:run}',
  })
  const approvalComposer = page.locator('[data-approval-composer]')
  const approvalFrame = page.locator('[data-approval-state]')
  await expect(approvalComposer).toBeVisible()
  await expect(approvalComposer).toBeFocused()
  await expect(approvalComposer).toHaveCSS('transform', 'none')
  await expect(approvalFrame).toHaveCSS('transform', 'none')
  const approvalBox = await page.locator('.parallax-approval-surface').boundingBox()
  expect(approvalBox).not.toBeNull()
  expect(
    Math.abs(
      (normalComposerBox!.x + normalComposerBox!.width / 2) -
      (approvalBox!.x + approvalBox!.width / 2),
    ),
  ).toBeLessThanOrEqual(1)
  await expect(approvalComposer).toContainText('ls -la')
  await expect(approvalComposer).not.toContainText('run ls -la')
  await expect(page.getByText(/review the command above/i)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeVisible()
  await expect(composer).toHaveCount(0)
  const approvalSurface = page.locator('.parallax-approval-surface')
  await expect(approvalSurface).toHaveCSS('transition-duration', '0.22s, 0.22s, 0.22s')
  const lightApprovalColors = await approvalSurface.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      background: style.backgroundColor,
      border: style.borderColor,
    }
  })
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  await expect(page.locator('html')).toHaveClass(/dark/)
  await expect
    .poll(() =>
      approvalSurface.evaluate((element) => {
        const style = getComputedStyle(element)
        return {
          background: style.backgroundColor,
          border: style.borderColor,
        }
      }),
    )
    .not.toEqual(lightApprovalColors)
  const darkApprovalColors = await approvalSurface.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      background: style.backgroundColor,
      border: style.borderColor,
    }
  })
  expect(lightApprovalColors.background).not.toBe('rgba(0, 0, 0, 0)')
  expect(darkApprovalColors.background).not.toBe('rgba(0, 0, 0, 0)')
  expect(darkApprovalColors).not.toEqual(lightApprovalColors)
  const executionCountAfterManualResponse = await page.evaluate(
    () => window.__parallaxHarness.executions.length,
  )
  expect(executionCountAfterManualResponse).toBe(executionCountBeforeManualResponse)
})
