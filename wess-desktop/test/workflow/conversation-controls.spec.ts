import { expect, test } from '@playwright/test'
import type { Conversation } from '../../hooks/useWess'
import {
  WORKFLOW_CHAT_URL,
  emitWorkflowEvent,
  installWorkflowHarness,
} from './harness'

function conversation(
  id: string,
  messages: Conversation['messages'],
  overrides: Partial<Conversation> = {},
): Conversation {
  return {
    id,
    title: id,
    messages,
    chatgptUrl: WORKFLOW_CHAT_URL,
    folderPath: '/tmp/workflow-project',
    updatedAt: 1,
    ...overrides,
  }
}

test('archives stay hidden until they are restored from Settings', async ({ page }) => {
  await installWorkflowHarness(page, {
    conversations: {
      active: conversation(
        'active',
        [{ role: 'user', text: 'Visible chat' }],
        { title: 'Visible chat' },
      ),
      archived: conversation(
        'archived',
        [{ role: 'user', text: 'Stored history' }],
        { title: 'Archived chat', archived: true },
      ),
    },
    convOrder: ['active', 'archived'],
    projects: ['/tmp/workflow-project'],
  })

  await page.goto('/')
  await expect(page.getByTitle('Visible chat')).toBeVisible()
  await expect(page.getByTitle('Archived chat')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Archived' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByText('Archived chat', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Restore Archived chat' }).click()
  await page.getByRole('button', { name: 'Close settings' }).click()
  await expect(page.getByTitle('Archived chat')).toBeVisible()
})

test('queues another message and drains it after authoritative completion', async ({ page }) => {
  await installWorkflowHarness(page, {
    conversations: {
      queue: conversation('queue', [], { title: 'Queue test' }),
    },
    projects: ['/tmp/workflow-project'],
  })

  await page.goto('/')
  const composer = page.getByRole('textbox')
  await composer.fill('First request')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Queue message' })).toHaveCount(0)

  await composer.fill('Second request')
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Queue message' })).toBeVisible()
  await page.getByRole('button', { name: 'Queue message' }).click()
  await expect(page.getByText('1 message queued')).toBeVisible()
  await expect(page.locator('[data-queued-message-preview]')).toHaveText('Second request')
  await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Queue message' })).toHaveCount(0)
  await expect
    .poll(() =>
      page.evaluate(() => window.__wessHarness.sends.filter((send) => !send.silent).length),
    )
    .toBe(1)

  const first = await page.evaluate(() =>
    window.__wessHarness.sends.find((send) => !send.silent),
  )
  await emitWorkflowEvent(page, 'sent', {
    text: 'First request',
    msgId: first?.msgId,
    convId: 'queue',
  })
  await emitWorkflowEvent(page, 'response', {
    text: 'First response',
    convId: 'queue',
    url: WORKFLOW_CHAT_URL,
  })

  await expect
    .poll(() =>
      page.evaluate(() => window.__wessHarness.sends.filter((send) => !send.silent).length),
    )
    .toBe(2)
  await expect(page.getByText('1 message queued')).toHaveCount(0)
  await expect(page.locator('[data-delivery="pending"]')).toContainText('Second request')
  const transcript = await page.locator('[data-wess-transcript]').innerText()
  expect(transcript.indexOf('First response')).toBeLessThan(transcript.indexOf('Second request'))

  const second = await page.evaluate(() =>
    window.__wessHarness.sends.filter((send) => !send.silent).at(-1),
  )
  await emitWorkflowEvent(page, 'sent', {
    text: 'Second request',
    msgId: second?.msgId,
    convId: 'queue',
  })
  await emitWorkflowEvent(page, 'response', {
    text: 'Second response',
    convId: 'queue',
    url: WORKFLOW_CHAT_URL,
  })
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0)
})

test('edits and deletes a message while it is still queued', async ({ page }) => {
  await installWorkflowHarness(page, {
    conversations: {
      queue: conversation('queue', [], { title: 'Queue controls' }),
    },
    projects: ['/tmp/workflow-project'],
  })

  await page.goto('/')
  const composer = page.getByRole('textbox')
  await composer.fill('First request')
  await page.getByRole('button', { name: 'Send message' }).click()

  await composer.fill('Second request')
  await page.getByRole('button', { name: 'Queue message' }).click()
  await expect(page.getByText('1 message queued')).toBeVisible()

  await page.getByRole('button', { name: 'Edit queued message' }).click()
  await expect(page.getByText('1 message queued')).toHaveCount(0)
  await expect(composer).toHaveValue('Second request')
  await expect(page.getByRole('button', { name: 'Queue message' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0)

  await composer.fill('Revised second request')
  await page.getByRole('button', { name: 'Queue message' }).click()
  await expect(page.locator('[data-queued-message-preview]')).toHaveText(
    'Revised second request',
  )

  await page.getByRole('button', { name: 'Delete queued message' }).click()
  await expect(page.getByText('1 message queued')).toHaveCount(0)
  await expect(composer).toHaveValue('')
  await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible()
})

test('edits a message across the full transcript width and replaces its branch', async ({ page }) => {
  await installWorkflowHarness(page, {
    conversations: {
      edit: conversation(
        'edit',
        [
          {
            role: 'user',
            text: 'Explain the repository.',
            msgId: 'original-message',
            delivery: 'sent',
          },
          { role: 'assistant', text: 'Old answer.' },
          {
            role: 'user',
            text: 'Old follow-up.',
            msgId: 'old-follow-up',
            delivery: 'sent',
          },
          { role: 'assistant', text: 'Old follow-up answer.' },
        ],
        { title: 'Edit test' },
      ),
    },
    projects: ['/tmp/workflow-project'],
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Edit message' }).first().click()
  const editor = page.locator('[data-message-editor]')
  await expect(editor).toBeVisible()
  const [editorBox, transcriptBox] = await Promise.all([
    editor.boundingBox(),
    page.locator('[data-wess-transcript] > div').first().boundingBox(),
  ])
  expect(editorBox).not.toBeNull()
  expect(transcriptBox).not.toBeNull()
  expect(editorBox!.width).toBeGreaterThan(transcriptBox!.width * 0.9)

  const textarea = page.getByRole('textbox', { name: 'Edit message text' })
  await textarea.fill('Explain the current repository structure.')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByText('Old answer.', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Old follow-up.', { exact: true })).toHaveCount(0)

  const edit = await page.evaluate(() => {
    const harness = window.__wessHarness as typeof window.__wessHarness & {
      edits: Array<Record<string, unknown>>
    }
    return harness.edits[0]
  })
  expect(edit).toMatchObject({
    convId: 'edit',
    originalText: 'Explain the repository.',
    text: 'Explain the current repository structure.',
    userIndex: 0,
  })

  await emitWorkflowEvent(page, 'sent', {
    text: edit.text,
    msgId: edit.msgId,
    convId: 'edit',
  })
  await emitWorkflowEvent(page, 'stream_update', {
    text: 'New answer is streaming.',
    convId: 'edit',
  })
  await expect(page.locator('[data-streaming-copy]')).toContainText('New answer is streaming.')
  await emitWorkflowEvent(page, 'response', {
    text: 'New answer is complete.',
    convId: 'edit',
    url: WORKFLOW_CHAT_URL,
  })
  await expect(page.getByText('New answer is complete.', { exact: true })).toBeVisible()
})
