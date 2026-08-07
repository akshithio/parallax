import { vi } from 'vitest'
import type { Conversation } from '../../hooks/useNix'

type Handler = (data: any) => void

export interface BridgeData {
  conversations: Record<string, Conversation>
  convOrder: string[]
  projects: string[]
}

export function createNixBridge(data: BridgeData) {
  const listeners = new Map<string, Set<Handler>>()
  const subscribe = (event: string) =>
    vi.fn((handler: Handler) => {
      const handlers = listeners.get(event) || new Set<Handler>()
      handlers.add(handler)
      listeners.set(event, handlers)
      return () => handlers.delete(handler)
    })

  const emit = (event: string, payload: any) => {
    for (const handler of listeners.get(event) || []) handler(payload)
  }

  const listenerCount = (event: string) => listeners.get(event)?.size || 0

  const api = {
    loadData: vi.fn(async () => ({
      ok: true,
      data: structuredClone(data),
    })),
    saveData: vi.fn(async () => ({ ok: true })),
    send: vi.fn(),
    editMessage: vi.fn(),
    sendFiles: vi.fn(),
    navigate: vi.fn(),
    newChat: vi.fn(),
    switchModel: vi.fn(),
    stopGenerating: vi.fn(),
    log: vi.fn(),
    selectFolder: vi.fn(async () => ({ ok: false })),
    agentExec: vi.fn(async ({ actions }: { actions: unknown[]; executionId?: string }) => ({
      results: actions.map(() => ({ status: 'ok', content: 'completed' })),
    })),
    ready: vi.fn(),
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

  return { api, emit, listenerCount }
}
