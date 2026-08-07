import type { Page } from '@playwright/test'
import type { Conversation } from '../../hooks/useNix'

export const WORKFLOW_CHAT_URL =
  'https://chatgpt.com/c/dddddddd-dddd-dddd-dddd-dddddddddddd'

export interface WorkflowHarnessOptions {
  conversations: Record<string, Conversation>
  convOrder?: string[]
  projects?: string[]
}

export async function installWorkflowHarness(
  page: Page,
  options: WorkflowHarnessOptions,
) {
  await page.addInitScript(
    ({ initial, chatUrl }) => {
      const listeners = new Map<string, Set<(payload: unknown) => void>>()
      const subscribe = (event: string) => (handler: (payload: unknown) => void) => {
        const handlers = listeners.get(event) || new Set()
        handlers.add(handler)
        listeners.set(event, handlers)
        return () => handlers.delete(handler)
      }
      const sends: Array<{
        text: string
        wireText?: string
        silent: boolean
        convId?: string
        msgId?: string
      }> = []
      const executions: Array<{ actions: Array<Record<string, unknown>> }> = []
      const edits: Array<Record<string, unknown>> = []
      const harness = {
        sends,
        executions,
        edits,
        emit(event: string, payload: unknown) {
          for (const handler of listeners.get(event) || []) handler(payload)
        },
      }

      window.__nixHarness = harness
      localStorage.setItem('nix:permission', 'full-access')
      localStorage.setItem('nix:theme', 'light')
      window.nix = {
        loadData: async () => ({
          ok: true,
          data: initial,
        }),
        saveData: async () => ({ ok: true }),
        send(
          text: string,
          _model: string | undefined,
          _intelligence: string | undefined,
          wireText: string | undefined,
          silent: boolean,
          _expectUrl: string | undefined,
          convId: string | undefined,
          msgId: string | undefined,
        ) {
          sends.push({ text, wireText, silent: Boolean(silent), convId, msgId })
        },
        editMessage(payload: Record<string, unknown>) {
          edits.push(payload)
        },
        agentExec: async ({ actions }: { actions: Array<Record<string, unknown>> }) => {
          executions.push({ actions })
          return {
            results: actions.map(() => ({ status: 'ok', content: 'completed' })),
          }
        },
        ready() {
          queueMicrotask(() => {
            harness.emit('status', { type: 'ws', status: 'connected' })
            for (const conversation of Object.values(initial.conversations)) {
              harness.emit('status', {
                type: 'chatgpt',
                status: 'ready',
                convId: conversation.id,
                url: conversation.chatgptUrl || chatUrl,
              })
            }
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
    {
      initial: {
        conversations: options.conversations,
        convOrder: options.convOrder || Object.keys(options.conversations),
        projects: options.projects || [],
      },
      chatUrl: WORKFLOW_CHAT_URL,
    },
  )
}

export async function emitWorkflowEvent(
  page: Page,
  event: string,
  payload: unknown,
) {
  await page.evaluate(
    ({ eventName, eventPayload }) => {
      window.__nixHarness.emit(eventName, eventPayload)
    },
    { eventName: event, eventPayload: payload },
  )
}
