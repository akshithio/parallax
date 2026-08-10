import { useEffect, useRef, useState, useCallback } from 'react'
import {
  HARNESS_PROTOCOL_VERSION,
  composeWireMessage,
  needsHarnessBootstrap,
} from '../lib/systemPrompt'
import { normalizeModels } from '../lib/modelGroups'
import {
  parseAgentActions,
  agentActionLabel,
  formatAgentResults,
  isNonReadAction,
  type AgentAction,
  type ToolAction,
  type ToolResult,
} from '../lib/agentProtocol'

declare global {
  interface Window { parallax: any; __parallax_project_cwd__?: string }
}

// Relay renderer-side pipeline events to the main-process terminal (always on),
// so the whole flow — renderer → main → extension → ChatGPT page — shows up in
// one place. Also mirrors to the DevTools console for good measure.
function wlog(msg: string, extra?: unknown) {
  try { window.parallax?.log?.('renderer', msg, extra) } catch {}
  // eslint-disable-next-line no-console
  if (extra !== undefined) console.log('[Parallax]', msg, extra); else console.log('[Parallax]', msg)
}
// Compact preview of a possibly-large string for log lines.
function prev(s?: string, n = 60): string {
  if (!s) return '∅'
  const one = s.replace(/\s+/g, ' ').trim()
  return `len=${s.length} "${one.slice(0, n)}${one.length > n ? '…' : ''}"`
}

function canonicalChatgptUrl(raw?: string | null): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw)
    const match = /^\/c\/([^/?#]+)/.exec(url.pathname)
    if (!match) return null
    const id = decodeURIComponent(match[1])
    if (!id || /^WEB:/i.test(id)) return null
    return `${url.origin}/c/${encodeURIComponent(id)}`
  } catch {
    return null
  }
}

function newMessageId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export type PermissionLevel = 'auto-review' | 'approve' | 'full-access'

export interface ModelVariant {
  label: string
  slug: string
}

/** One "Intelligence" option ChatGPT shows for a model (e.g. Instant/Medium/High). */
export interface ModelIntelligence {
  label: string
  /** Optional hint ChatGPT shows next to it (e.g. Instant → "5.3"). */
  hint?: string
}

export interface ModelOption {
  slug: string // identity — the model's display title (no backend slug exists in the DOM)
  title: string // display name exactly as ChatGPT shows it, e.g. "GPT-5.6 Sol"
  /** Optional secondary line ChatGPT shows under a model (e.g. "Leaving on July 23"). */
  sublabel?: string
  /** Per-model Intelligence tiers, scraped from ChatGPT's live menu. */
  intelligences?: ModelIntelligence[]
  variants?: ModelVariant[] // legacy; unused
}

export type ModelSelectionStatus = 'idle' | 'pending' | 'confirmed' | 'error'

interface ConfirmedModelSelection {
  model?: string
  intelligence?: string
}

// Placeholder shown only until the extension scrapes ChatGPT's live menu. Titles
// only — intelligence is per-model and comes entirely from the DOM.
const MODEL_FALLBACK: ModelOption[] = [
  { slug: 'GPT-5.6 Sol', title: 'GPT-5.6 Sol' },
  { slug: 'GPT-5.5', title: 'GPT-5.5' },
  { slug: 'o3', title: 'o3' },
]

export interface AgentCall {
  kind: 'read' | 'list' | 'search' | 'run' | 'write'
  label: string
  status: 'running' | 'ok' | 'error' | 'awaiting' | 'blocked' | 'denied'
  result?: string
  /** ‹plx:write› only: unified diff of the change, for the diff view in the card. */
  diff?: string
  /** Target path for read/list/write — lets the card highlight by file extension. */
  path?: string
  nonRead?: boolean
}

export interface PendingApproval {
  convId: string
  actions: ToolAction[]
}

/**
 * One step of a turn IN THE ORDER THE MODEL EMITTED IT.
 *
 * `notes` and `calls` are stored as separate arrays (calls have to stay a dense
 * list so execution results map back by index), which on its own throws away the
 * interleaving: note → run → note → run rendered as note, note, run, run, so every
 * bit of narration sat above calls it had nothing to do with. `steps` records the
 * original sequence; `index` points into `calls`.
 */
export type MessageStep = { kind: 'note'; text: string } | { kind: 'call'; index: number }

export interface Message {
  role: 'user' | 'assistant'
  text: string
  msgId?: string
  /** Local delivery state for user messages. */
  delivery?: 'queued' | 'pending' | 'sent' | 'failed'
  toolCalls?: string
  attachments?: { name: string; mime: string; data?: string }[]
  /** Agent harness: status notes the model emitted this turn. */
  notes?: string[]
  /** Agent harness: read-only tool calls this turn, with results once executed. */
  calls?: AgentCall[]
  /** The turn's notes and calls in the model's own order (see MessageStep). */
  steps?: MessageStep[]
  /** True while tokens are still arriving — the UI renders these cheaply. */
  streaming?: boolean
}

type OutgoingAttachment = { name: string; data: string; mime: string }

export interface Conversation {
  id: string
  title: string
  messages: Message[]
  chatgptUrl: string | null
  folderPath: string | null
  updatedAt?: number
  /** A completed response arrived while another thread was open. */
  unread?: boolean
  /** Whether this browser conversation has received the workspace protocol. */
  protocolReady?: boolean
  /** Contract revision last delivered to this browser conversation. */
  protocolVersion?: number
  /** Archived threads stay hidden until restored from Settings. */
  archived?: boolean
}

function normalizeLoadedConversations(
  input: Record<string, Conversation> | null | undefined,
): Record<string, Conversation> {
  const source = input && typeof input === 'object' ? input : {}
  const normalized: Record<string, Conversation> = {}
  const claimedUrls = new Set<string>()
  // A canonical ChatGPT conversation can belong to one desktop thread. When old
  // buggy state bound the same URL to several threads, preserve it on the newest
  // thread and detach the older copies without deleting any transcript.
  const entries = Object.entries(source).sort(
    ([, a], [, b]) => (b?.updatedAt || 0) - (a?.updatedAt || 0),
  )
  for (const [id, conversation] of entries) {
    const canonical = canonicalChatgptUrl(conversation?.chatgptUrl)
    const chatgptUrl = canonical && !claimedUrls.has(canonical) ? canonical : null
    if (chatgptUrl) claimedUrls.add(chatgptUrl)
    const messages = Array.isArray(conversation?.messages)
      ? conversation.messages.map((message) => ({
          ...message,
          streaming: false,
          delivery:
            message.role === 'user' &&
            (message.delivery === 'pending' || message.delivery === 'queued')
              ? 'failed' as const
              : message.delivery,
        }))
      : []
    const protocolReady =
      conversation?.protocolReady ??
      messages.some((message) =>
        Boolean(message.calls?.length) ||
        /(?:^|[<{‹⟨«〈＜〈])\s*plx:(?:note|run|write|done)\b/i.test(message.text || ''),
      )
    normalized[id] = {
      ...conversation,
      id,
      chatgptUrl,
      messages,
      protocolReady,
    }
  }
  return normalized
}

// Safety cap on how many read → execute → feed-back rounds one task may run.
const MAX_AGENT_LOOP = 30

interface StructuredAgentTurn {
  toolActions: ToolAction[]
  hasApprovalAction: boolean
  message: Message
}

function structuredAgentTurn(
  actions: AgentAction[],
  level: PermissionLevel,
  streaming: boolean,
): StructuredAgentTurn {
  const parsedToolActions = actions.filter(
    (action): action is ToolAction =>
      action.type === 'read' ||
      action.type === 'list' ||
      action.type === 'search' ||
      action.type === 'run' ||
      action.type === 'write',
  )
  const requiresManualApproval = (action: ToolAction) =>
    action.type === 'run' || action.type === 'write'
  const requestsReview = (action: ToolAction) =>
    (action.type === 'run' || action.type === 'write') &&
    action.approval === 'required'
  const firstApprovalAction =
    level === 'approve'
      ? parsedToolActions.find(requiresManualApproval)
      : level === 'auto-review'
        ? parsedToolActions.find(requestsReview)
        : undefined
  const toolActions = firstApprovalAction ? [firstApprovalAction] : parsedToolActions
  const selectedToolActions = new Set<ToolAction>(toolActions)
  const needsApproval = (action: ToolAction) =>
    level === 'approve'
      ? requiresManualApproval(action)
      : level === 'auto-review' && requestsReview(action)

  const notes = actions
    .filter((action): action is Extract<AgentAction, { type: 'note' }> => action.type === 'note')
    .map((action) => action.text)
  const steps: MessageStep[] = []
  let stepCallIndex = 0
  for (const action of actions) {
    if (action.type === 'note') {
      if (action.text.trim()) steps.push({ kind: 'note', text: action.text })
      continue
    }
    if (
      action.type !== 'read' &&
      action.type !== 'list' &&
      action.type !== 'search' &&
      action.type !== 'run' &&
      action.type !== 'write'
    ) {
      continue
    }
    if (!selectedToolActions.has(action)) continue
    steps.push({ kind: 'call', index: stepCallIndex++ })
  }

  return {
    toolActions,
    hasApprovalAction: toolActions.some(needsApproval),
    message: {
      role: 'assistant',
      text: '',
      streaming,
      notes: notes.length ? notes : undefined,
      steps: steps.length ? steps : undefined,
      calls: toolActions.length
        ? toolActions.map((action) => ({
            kind: action.type,
            label: agentActionLabel(action),
            status: needsApproval(action) ? 'awaiting' : 'running',
            path:
              action.type === 'read' || action.type === 'list' || action.type === 'write'
                ? action.path
                : undefined,
            nonRead: isNonReadAction(action),
          }))
        : undefined,
    },
  }
}

export default function useParallax() {
  const [conversations, setConversations] = useState<Record<string, Conversation>>({})
  const [convOrder, setConvOrder] = useState<string[]>([])
  const [currentConvId, setCurrentConvId] = useState<string | null>(null)
  const [workingConvIds, setWorkingConvIds] = useState<Set<string>>(() => new Set())
  const [queuedMessageCounts, setQueuedMessageCounts] = useState<Record<string, number>>({})
  const sending = workingConvIds.size > 0
  // False until the persisted conversations have been read off disk. The UI holds
  // a neutral blank until then instead of flashing the "no projects" empty state.
  const [dataLoaded, setDataLoaded] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [serverStatus, setServerStatus] = useState({ status: 'waiting', detail: '' })
  const [wsStatus, setWsStatus] = useState({ status: 'waiting', detail: '' })
  const [chatgptStatus, setChatgptStatus] = useState({ status: 'waiting', detail: '' })
  const [extensionWarningVisible, setExtensionWarningVisible] = useState(false)
  // The model list mirrors the options in ChatGPT's live picker; until the picker
  // has been inspected we show a fallback. `gptModel` holds the exact picker title
  // confirmed on the current conversation's ChatGPT tab.
  // Both start from constants (not localStorage) so SSR and the first client render
  // agree; persisted values are loaded in an effect below to avoid a hydration mismatch.
  const [availableModels, setAvailableModels] = useState<ModelOption[]>(MODEL_FALLBACK)
  const [gptModel, setGptModelState] = useState<string>(MODEL_FALLBACK[0].slug)
  const [selectionStatus, setSelectionStatus] = useState<ModelSelectionStatus>('idle')
  const confirmedSelectionByConv = useRef<Record<string, ConfirmedModelSelection>>({})
  const setGptModel = useCallback((slug: string) => {
    const convId = snap.current.currentConvId
    if (!convId) return
    setGptModelState(slug)
    setIntelligenceLevelState('')
    setSelectionStatus('pending')
    try { localStorage.setItem('parallax:model', slug) } catch {}
    // Switch it on this conversation's dedicated ChatGPT tab immediately.
    try { window.parallax?.switchModel?.(slug, undefined, convId) } catch {}
  }, [])
  // Per-model Intelligence tiers learned from ChatGPT's live menu (title → tiers).
  // Accumulated because ChatGPT only renders the CURRENT model's options at a time.
  const intelByModel = useRef<Record<string, ModelIntelligence[]>>({})
  useEffect(() => {
    try {
      const rawModels = localStorage.getItem('parallax:models')
      const parsed = rawModels ? JSON.parse(rawModels) : null
      const list = normalizeModels(Array.isArray(parsed) ? parsed : [])
      if (list.length) setAvailableModels(list)
      const rawIntel = localStorage.getItem('parallax:intelByModel')
      const obj = rawIntel ? JSON.parse(rawIntel) : null
      if (obj && typeof obj === 'object') intelByModel.current = obj
      const m = localStorage.getItem('parallax:model')
      if (m) setGptModelState(m)
      const intelligence = localStorage.getItem('parallax:intelligence')
      if (intelligence) setIntelligenceLevelState(intelligence)
    } catch {}
  }, [])
  const [intelligenceLevel, setIntelligenceLevelState] = useState('Medium')
  const setIntelligenceLevel = useCallback((level: string) => {
    const convId = snap.current.currentConvId
    if (!convId) return
    setIntelligenceLevelState(level)
    setSelectionStatus('pending')
    try { localStorage.setItem('parallax:intelligence', level) } catch {}
    // Apply the reasoning tier to the current model on the site (model undefined =
    // keep the current model, just change its tier).
    try { window.parallax?.switchModel?.(undefined, level, convId) } catch {}
  }, [])
  // Projects = workspace folders the threads are organized under.
  const [projects, setProjects] = useState<string[]>([])
  // Permission gate for non-read (run/write) actions.
  const [permissionLevel, setPermissionLevelState] = useState<PermissionLevel>('auto-review')
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null)

  const snap = useRef({ conversations, convOrder, currentConvId, projects })
  useEffect(() => { snap.current = { conversations, convOrder, currentConvId, projects } })
  useEffect(() => {
    if (!currentConvId) {
      setSelectionStatus('idle')
      return
    }
    const confirmed = confirmedSelectionByConv.current[currentConvId]
    if (!confirmed) {
      setSelectionStatus('idle')
      return
    }
    if (confirmed.model) setGptModelState(confirmed.model)
    setIntelligenceLevelState(confirmed.intelligence || '')
    setSelectionStatus('confirmed')
  }, [currentConvId])

  // Persist EVERYTHING (assistant replies + agent state included) whenever it
  // changes — debounced. Previously only user messages were saved (via
  // addMessageToConv), so a reply was lost on reopen until the next message.
  // `hasLoaded` guards against overwriting the on-disk data with the empty
  // initial state before loadData() resolves.
  const hasLoaded = useRef(false)
  useEffect(() => {
    if (!hasLoaded.current || !window.parallax) return
    const t = setTimeout(() => {
      window.parallax?.saveData({ conversations, convOrder, projects })
    }, 400)
    return () => clearTimeout(t)
  }, [conversations, convOrder, projects])

  const permissionRef = useRef(permissionLevel)
  useEffect(() => { permissionRef.current = permissionLevel }, [permissionLevel])

  // Transport remains single-flight for now, but presentation state belongs to
  // the thread that owns the turn. A global boolean made every composer show Stop
  // and every open transcript show Thinking while one background thread worked.
  const workingConvIdsRef = useRef<Set<string>>(new Set())
  const sendingRef = useRef(false)
  const setSending = useCallback((v: boolean, why: string, explicitConvId?: string | null) => {
    const convId =
      explicitConvId ||
      activeSendConv.current ||
      workingConvIdsRef.current.values().next().value ||
      snap.current.currentConvId ||
      ''
    if (!convId) {
      wlog(`working state ignored — no task identity (${why})`)
      return
    }
    const next = new Set(workingConvIdsRef.current)
    const before = next.has(convId)
    if (v) next.add(convId)
    else next.delete(convId)
    if (before !== v) wlog(`working conv=${convId} ${before} → ${v} (${why})`)
    workingConvIdsRef.current = next
    sendingRef.current = next.size > 0
    setWorkingConvIds(next)
  }, [])

  const setPermissionLevel = useCallback((level: PermissionLevel) => {
    // Event handlers read this ref directly. Update it in the same tick as the
    // menu click so an action response cannot observe the previous access level
    // while React is still scheduling the state update.
    permissionRef.current = level
    setPermissionLevelState(level)
    try { localStorage.setItem('parallax:permission', level) } catch {}
    wlog(`access level → ${level}`)
  }, [])

  useEffect(() => {
    try {
      const saved = localStorage.getItem('parallax:permission') as PermissionLevel | null
      if (saved === 'auto-review' || saved === 'approve' || saved === 'full-access') {
        permissionRef.current = saved
        setPermissionLevelState(saved)
      }
    } catch {}
  }, [])

  // Actual tab location per desktop conversation. A global "last URL" cannot
  // represent multiple dedicated ChatGPT tabs and caused reconnects to cross-bind
  // otherwise unrelated desktop threads.
  const chatgptUrlByConv = useRef<Record<string, string>>({})
  useEffect(() => {
    if (!currentConvId) return
    const url = chatgptUrlByConv.current[currentConvId]
    if (url) setChatgptStatus({ status: 'ready', detail: url })
  }, [currentConvId])
  const pendingText = useRef<string | null>(null)
  const pendingWire = useRef<string | undefined>(undefined)
  const pendingModel = useRef<string | undefined>(undefined)
  const pendingIntelligence = useRef<string | undefined>(undefined)
  const navigatingToUrl = useRef<string | null>(null)
  const streamingConvId = useRef<string | null>(null)
  // The conversation the in-flight send belongs to. Responses/stream updates route
  // here — NOT to `currentConvId` — so switching chats mid-response (or a stale
  // stream arriving) can't drop a reply into the wrong thread.
  const activeSendConv = useRef<string | null>(null)
  // Turn boundaries and loop guards belong to a conversation. Shared booleans and
  // counters let an older background task consume a newer task's state.
  const startNewAssistantTurns = useRef(new Set<string>())
  const agentLoopCounts = useRef(new Map<string, number>())
  const protocolRetryCounts = useRef(new Map<string, number>())
  const pendingProtocolBootstraps = useRef(new Map<string, string>())
  const streamSnapshotLengths = useRef(new Map<string, number>())
  const activeToolExecutions = useRef(
    new Map<string, { convId: string; callIndex: number }>(),
  )

  // Live mirror of the extension link so send() can decide synchronously (state is
  // async). We queue ONLY on an explicit "disconnected" — never on the transient
  // "waiting" state a fresh/reloaded renderer starts in, which would wrongly hold
  // messages even though the extension is connected (main re-syncs status on load).
  const wsOfflineRef = useRef(false)
  useEffect(() => { wsOfflineRef.current = wsStatus.status === 'disconnected' }, [wsStatus])
  // Keep the transport state immediate so offline sends queue correctly, but do
  // not flash a user-facing outage banner for normal startup/reload reconnects.
  useEffect(() => {
    if (wsStatus.status !== 'disconnected') {
      setExtensionWarningVisible(false)
      return
    }
    const timer = setTimeout(() => setExtensionWarningVisible(true), 4000)
    return () => clearTimeout(timer)
  }, [wsStatus.status])
  // When a send arrives while the extension is offline we DON'T force a new chat or
  // hang — we hold the message on its own thread and replay it the moment the link
  // is back, so the user just keeps working in the same conversation.
  const queuedSend = useRef<{
    convId: string | null
    msgId: string
    text: string
    model?: string
    intelligence?: string
    context?: string
    wire?: string
    attachments?: OutgoingAttachment[]
  } | null>(null)
  type QueuedUserSend = {
    convId: string
    msgId: string
    text: string
    model?: string
    intelligence?: string
    context?: string
    attachments?: OutgoingAttachment[]
  }
  const queuedUserSends = useRef<QueuedUserSend[]>([])
  type AgentContinuation = {
    convId: string
    msgId: string
    wire: string
    startsNewTurn: boolean
  }
  const pendingAgentContinuations = useRef(new Map<string, AgentContinuation>())
  const queuedAgentContinuations = useRef(new Map<string, AgentContinuation>())
  const continuationRetryTimers = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  )
  const queuedFiles = useRef(
    new Map<string, { name: string; data: string; mime: string }[]>(),
  )
  const pendingAttachments = useRef(
    new Map<string, { name: string; data: string; mime: string }[]>(),
  )
  // The last payload handed to the extension, kept so it can be replayed verbatim
  // if the page refuses it (tab sitting on a different conversation).
  const lastOutgoing = useRef<{
    convId: string | null
    msgId: string
    text: string
    wire?: string
    model?: string
    intelligence?: string
    silent: boolean
  } | null>(null)
  // Guard against a navigate → refuse → navigate loop if something stays wrong.
  const wrongConvRetry = useRef(0)
  const [queuedNotice, setQueuedNotice] = useState<string | null>(null)
  const sendRef = useRef<(
    text: string,
    model?: string,
    intelligence?: string,
    context?: string,
    attachments?: OutgoingAttachment[],
    existingMsgId?: string,
    existingWire?: string,
    targetConvId?: string,
  ) => void>(() => {})
  const unconfirmedUserMessages = useRef(new Set<string>())

  function clearAgentContinuations(convId: string) {
    for (const [msgId, continuation] of pendingAgentContinuations.current) {
      if (continuation.convId !== convId) continue
      pendingAgentContinuations.current.delete(msgId)
      queuedAgentContinuations.current.delete(msgId)
      const timer = continuationRetryTimers.current.get(msgId)
      if (timer) clearTimeout(timer)
      continuationRetryTimers.current.delete(msgId)
    }
  }

  function dispatchAgentContinuation(continuation: AgentContinuation) {
    pendingAgentContinuations.current.set(continuation.msgId, continuation)
    activeSendConv.current = continuation.convId
    setSending(true, 'agent continuation pending', continuation.convId)
    if (continuation.startsNewTurn) {
      startNewAssistantTurns.current.add(continuation.convId)
    } else {
      startNewAssistantTurns.current.delete(continuation.convId)
    }

    const transport = window.parallax?.send
    if (wsOfflineRef.current || typeof transport !== 'function') {
      queuedAgentContinuations.current.set(continuation.msgId, continuation)
      wlog(`agent continuation QUEUED conv=${continuation.convId}`)
      return
    }

    queuedAgentContinuations.current.delete(continuation.msgId)
    const expect =
      snap.current.conversations[continuation.convId]?.chatgptUrl || undefined
    lastOutgoing.current = {
      convId: continuation.convId,
      msgId: continuation.msgId,
      text: '',
      wire: continuation.wire,
      model: undefined,
      intelligence: undefined,
      silent: true,
    }
    transport(
      '',
      undefined,
      undefined,
      continuation.wire,
      true,
      expect,
      continuation.convId,
      continuation.msgId,
    )
  }

  function sendAgentContinuation(
    convId: string,
    wire: string,
    startsNewTurn: boolean,
  ) {
    dispatchAgentContinuation({
      convId,
      wire,
      startsNewTurn,
      msgId: newMessageId(),
    })
  }

  function retryAgentContinuation(
    continuation: AgentContinuation,
    delay = 350,
  ) {
    queuedAgentContinuations.current.set(continuation.msgId, continuation)
    const existing = continuationRetryTimers.current.get(continuation.msgId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      continuationRetryTimers.current.delete(continuation.msgId)
      if (!pendingAgentContinuations.current.has(continuation.msgId)) return
      dispatchAgentContinuation(continuation)
    }, delay)
    continuationRetryTimers.current.set(continuation.msgId, timer)
  }

  function addMessageToConv(convId: string, role: 'user' | 'assistant', data: any) {
    setConversations(prev => {
      const conv = prev[convId]
      if (!conv) return prev
      if (data.msgId && conv.messages.some(m => m.msgId === data.msgId)) return prev
      const msg: Message = {
        role,
        text: data.text || '',
        msgId: data.msgId,
        delivery: data.delivery,
        toolCalls: data.toolCalls,
        attachments: data.attachments,
      }
      const updated = { ...conv, messages: [...conv.messages, msg], updatedAt: Date.now() }
      if (role === 'user' && data.text && conv.messages.filter(m => m.role === 'user').length === 0) {
        updated.title = data.text.length > 40 ? data.text.slice(0, 40) + '…' : data.text
      }
      const newConvs = { ...prev, [convId]: updated }
      setTimeout(() => {
        const s = snap.current
        window.parallax?.saveData({ conversations: newConvs, convOrder: s.convOrder, projects: s.projects })
      }, 0)
      return newConvs
    })
  }

  function markUnreadIfBackground(convId: string) {
    if (!convId || convId === snap.current.currentConvId) return
    setConversations(prev => {
      const conv = prev[convId]
      if (!conv || conv.unread) return prev
      return {
        ...prev,
        [convId]: { ...conv, unread: true, updatedAt: Date.now() },
      }
    })
  }

  function updateToolCall(
    convId: string,
    callIndex: number,
    update: Partial<AgentCall>,
  ) {
    setConversations(prev => {
      const conv = prev[convId]
      if (!conv) return prev
      const messages = [...conv.messages]
      let messageIndex = messages.length - 1
      while (
        messageIndex >= 0 &&
        !(messages[messageIndex].role === 'assistant' && messages[messageIndex].calls)
      ) {
        messageIndex--
      }
      if (messageIndex < 0) return prev
      const message = messages[messageIndex]
      if (!message.calls?.[callIndex]) return prev
      const calls = [...message.calls]
      calls[callIndex] = { ...calls[callIndex], ...update }
      messages[messageIndex] = { ...message, calls }
      return { ...prev, [convId]: { ...conv, messages } }
    })
  }

  function setMessageDelivery(
    convId: string,
    msgId: string,
    delivery: NonNullable<Message['delivery']>,
  ) {
    setConversations(prev => {
      const conv = prev[convId]
      if (!conv) return prev
      const index = conv.messages.findIndex(message => message.msgId === msgId)
      if (index < 0 || conv.messages[index].role !== 'user') return prev
      const messages = [...conv.messages]
      messages[index] = { ...messages[index], delivery }
      return { ...prev, [convId]: { ...conv, messages, updatedAt: Date.now() } }
    })
  }

  function confirmUserMessage(
    convId: string,
    data: { text?: string; msgId: string; attachments?: Message['attachments'] },
  ) {
    setConversations(prev => {
      const conv = prev[convId]
      if (!conv) return prev
      const index = conv.messages.findIndex(message => message.msgId === data.msgId)
      if (index >= 0) {
        const messages = [...conv.messages]
        messages[index] = { ...messages[index], delivery: 'sent' }
        return { ...prev, [convId]: { ...conv, messages, updatedAt: Date.now() } }
      }
      const message: Message = {
        role: 'user',
        text: data.text || '',
        msgId: data.msgId,
        attachments: data.attachments,
        delivery: 'sent',
      }
      const updated = {
        ...conv,
        messages: [...conv.messages, message],
        updatedAt: Date.now(),
      }
      if (data.text && conv.messages.every(existing => existing.role !== 'user')) {
        updated.title = data.text.length > 40 ? `${data.text.slice(0, 40)}…` : data.text
      }
      return { ...prev, [convId]: updated }
    })
  }

  useEffect(() => {
    if (!window.parallax) {
      hasLoaded.current = true
      setDataLoaded(true)
      newConversation(null, true)
      return
    }
    const listenerCleanups: Array<() => void> = []
    const trackListener = (cleanup: unknown) => {
      if (typeof cleanup === 'function') listenerCleanups.push(cleanup as () => void)
    }

    window.parallax?.loadData().then((result: any) => {
      if (result.ok && result.data) {
        setConversations(normalizeLoadedConversations(result.data.conversations))
        setConvOrder(result.data.convOrder || [])
        setProjects(result.data.projects || [])
        const order: string[] = result.data.convOrder || []
        const first = order.find(
          (id: string) =>
            result.data.conversations?.[id] &&
            !result.data.conversations[id].archived,
        )
        if (first) setCurrentConvId(first)
      }
      hasLoaded.current = true
      // Flip only AFTER the persisted threads are in state, so a ⌘R never flashes
      // the "Add a project to get started" empty state before the chat appears.
      setDataLoaded(true)
    }).catch(() => setDataLoaded(true))

    trackListener(window.parallax?.onStatus((data: any) => {
      if (data.type === 'server') {
        setServerStatus({ status: data.status, detail: data.port || data.message || '' })
      } else if (data.type === 'ws') {
        setWsStatus({ status: data.status, detail: '' })
      } else if (data.type === 'chatgpt') {
        const sourceId =
          (typeof data.convId === 'string' && data.convId) ||
          activeSendConv.current ||
          snap.current.currentConvId ||
          ''
        // The tab moved within ChatGPT's SPA (user clicked another conversation, or
        // a stray click navigated it). Correct ONLY our view of where the tab is —
        // never re-bind the thread's saved chat. Without this the desktop keeps
        // believing the tab is still on the thread's conversation and types the next
        // message into whatever chat is on screen.
        if (data.status === 'tab_url') {
          const previous = sourceId ? chatgptUrlByConv.current[sourceId] : ''
          if (sourceId && data.url && data.url !== previous) {
            wlog(`tab moved for conv=${sourceId} → ${data.url} (was ${previous || 'unknown'})`)
            chatgptUrlByConv.current[sourceId] = data.url
          }
          return
        }
        if (data.status === 'ready') {
          if (sourceId && data.url) chatgptUrlByConv.current[sourceId] = data.url
          if (sourceId === snap.current.currentConvId) {
            setChatgptStatus({ status: 'ready', detail: data.url || '' })
          }
          navigatingToUrl.current = null
          // Only a durable /c/<id> link belongs in persisted thread state. Saving
          // "/" or the transient /c/WEB:* address made unrelated drafts share a
          // fake identity and broke every later send guard.
          const canonical = canonicalChatgptUrl(data.url)
          if (canonical && sourceId) {
            setConversations(prev => {
              if (!prev[sourceId]) return prev
              return { ...prev, [sourceId]: { ...prev[sourceId], chatgptUrl: canonical } }
            })
          }
          if (pendingText.current !== null && sourceId === activeSendConv.current) {
            const text = pendingText.current
            const wire = pendingWire.current
            const model = pendingModel.current
            const intelligence = pendingIntelligence.current
            const outgoing = lastOutgoing.current
            pendingText.current = null
            pendingWire.current = undefined
            pendingModel.current = undefined
            pendingIntelligence.current = undefined
            const continuation =
              outgoing?.silent && outgoing.msgId
                ? pendingAgentContinuations.current.get(outgoing.msgId)
                : undefined
            if (continuation) {
              dispatchAgentContinuation(continuation)
              return
            }
            // Still pass the thread's stored link so the page re-verifies even here.
            const expect =
              canonical ||
              snap.current.conversations[sourceId]?.chatgptUrl ||
              undefined
            window.parallax?.send(
              text,
              model,
              intelligence,
              wire,
              outgoing?.silent ?? false,
              expect,
              sourceId,
              outgoing?.msgId,
            )
          }
        } else if (data.status === 'navigating') {
          if (sourceId === snap.current.currentConvId) {
            setChatgptStatus({ status: 'navigating', detail: data.url || '' })
          }
        }
      }
    }))

    trackListener(window.parallax?.onSent((data: any) => {
      const id = typeof data?.convId === 'string' ? data.convId : ''
      if (!id || !snap.current.conversations[id]) {
        wlog(`onSent DROPPED — missing or unknown convId for msg=${data?.msgId || '-'}`)
        return
      }
      setSending(true, 'onSent — page confirmed submit', id)
      setErrorMessage(null)
      const continuation = pendingAgentContinuations.current.get(data?.msgId)
      if (continuation) {
        const timer = continuationRetryTimers.current.get(continuation.msgId)
        if (timer) clearTimeout(timer)
        continuationRetryTimers.current.delete(continuation.msgId)
        queuedAgentContinuations.current.delete(continuation.msgId)
        wlog(`onSent → agent continuation accepted conv=${id}`)
        return
      }
      wlog(`onSent → confirm user msg in conv=${id || '(none)'} ${prev(data.text)}`)
      const attachments = pendingAttachments.current.get(id)
      pendingAttachments.current.delete(id)
      unconfirmedUserMessages.current.delete(data.msgId)
      confirmUserMessage(id, {
        text: data.text,
        msgId: data.msgId,
        attachments,
      })
      if (pendingProtocolBootstraps.current.get(data.msgId) === id) {
        pendingProtocolBootstraps.current.delete(data.msgId)
        setConversations(prev => {
          const conv = prev[id]
          if (!conv) return prev
          return {
            ...prev,
            [id]: {
              ...conv,
              protocolReady: true,
              protocolVersion: HARNESS_PROTOCOL_VERSION,
            },
          }
        })
      }
    }))

    trackListener(window.parallax?.onAgentExecProgress?.((data: any) => {
      const execution = activeToolExecutions.current.get(data?.executionId)
      if (!execution || typeof data?.content !== 'string') return
      updateToolCall(execution.convId, execution.callIndex, {
        status: 'running',
        result: data.content,
      })
    }))

    // Model picker data scraped from ChatGPT's live menu (DOM-only). Each message
    // carries the visible model list (only present while the submenu is open), the
    // current model, and that model's Intelligence tiers. We accumulate the tiers
    // per model since ChatGPT only shows one model's options at a time.
    trackListener(window.parallax?.onModels?.((data: any) => {
      const sourceConvId =
        (typeof data?.convId === 'string' && data.convId) ||
        snap.current.currentConvId ||
        ''
      const incoming: { title: string; sublabel?: string }[] = Array.isArray(data?.models)
        ? data.models
            .filter((m: any) => m && typeof m.title === 'string' && m.title.trim())
            .map((m: any) => ({ title: m.title.trim(), sublabel: m.sublabel ? String(m.sublabel).trim() : undefined }))
        : []
      const currentModel = typeof data?.currentModel === 'string' ? data.currentModel.trim() : ''
      const currentIntelligence =
        typeof data?.currentIntelligence === 'string' ? data.currentIntelligence.trim() : ''
      const intelligences: ModelIntelligence[] = Array.isArray(data?.intelligences)
        ? data.intelligences
            .filter((i: any) => i && typeof i.label === 'string' && i.label.trim())
            .map((i: any) => ({ label: i.label.trim(), ...(i.hint ? { hint: String(i.hint).trim() } : {}) }))
        : []

      // Diagnostic: shows in the Parallax app's DevTools console. If `intel` or
      // `current` are empty here, the extension isn't sending them (scrape/forward
      // issue); if they're set but the picker stays empty, it's a render issue.
      // eslint-disable-next-line no-console
      console.log('[Parallax] onModels ← conv:', sourceConvId || '(none)', '| models:', incoming.length, '| current:', currentModel || '(none)', '| selected-intel:', currentIntelligence || '(none)', '| intel:', intelligences.map(i => i.label).join(',') || '(none)')

      if (currentModel && intelligences.length) {
        intelByModel.current = { ...intelByModel.current, [currentModel]: intelligences }
        try { localStorage.setItem('parallax:intelByModel', JSON.stringify(intelByModel.current)) } catch {}
      }

      setAvailableModels(prev => {
        const base = incoming.length
          ? normalizeModels(incoming.map(m => ({ slug: m.title, title: m.title, sublabel: m.sublabel })))
          : prev
        const withIntel = base.map(m => {
          const intel = intelByModel.current[m.title] || m.intelligences
          return intel && intel.length ? { ...m, intelligences: intel } : { ...m, intelligences: undefined }
        })
        try { localStorage.setItem('parallax:models', JSON.stringify(withIntel)) } catch {}
        return withIntel
      })

      // This is confirmed state from one specific ChatGPT tab. Cache it under that
      // conversation and only update the visible bar if that conversation is open.
      if (sourceConvId && (currentModel || currentIntelligence)) {
        const previous = confirmedSelectionByConv.current[sourceConvId] || {}
        const confirmed = {
          model: currentModel || previous.model,
          intelligence: currentIntelligence || previous.intelligence,
        }
        confirmedSelectionByConv.current = {
          ...confirmedSelectionByConv.current,
          [sourceConvId]: confirmed,
        }
        if (sourceConvId === snap.current.currentConvId) {
          if (confirmed.model) {
            setGptModelState(confirmed.model)
            try { localStorage.setItem('parallax:model', confirmed.model) } catch {}
          }
          setIntelligenceLevelState(confirmed.intelligence || '')
          if (confirmed.intelligence) {
            try { localStorage.setItem('parallax:intelligence', confirmed.intelligence) } catch {}
          }
          setSelectionStatus('confirmed')
        }
      }
    }))

    trackListener(window.parallax?.onSelectionError?.((data: any) => {
      const sourceConvId =
        (typeof data?.convId === 'string' && data.convId) ||
        snap.current.currentConvId ||
        ''
      const currentModel = typeof data?.currentModel === 'string' ? data.currentModel.trim() : ''
      const currentIntelligence =
        typeof data?.currentIntelligence === 'string' ? data.currentIntelligence.trim() : ''
      if (sourceConvId && (currentModel || currentIntelligence)) {
        const previous = confirmedSelectionByConv.current[sourceConvId] || {}
        const confirmed = {
          model: currentModel || previous.model,
          intelligence: currentIntelligence || previous.intelligence,
        }
        confirmedSelectionByConv.current = {
          ...confirmedSelectionByConv.current,
          [sourceConvId]: confirmed,
        }
        if (sourceConvId === snap.current.currentConvId) {
          if (confirmed.model) setGptModelState(confirmed.model)
          setIntelligenceLevelState(confirmed.intelligence || '')
        }
      }
      if (sourceConvId === snap.current.currentConvId) {
        setSelectionStatus('error')
        const message = data?.message || 'Could not apply the selected model or intelligence.'
        setErrorMessage(message)
        setTimeout(() => setErrorMessage(null), 8000)
      }
    }))

    trackListener(window.parallax?.onStreamUpdate((data: any) => {
      const id = typeof data?.convId === 'string' ? data.convId : ''
      if (!id || !snap.current.conversations[id]) {
        wlog(`stream_update DROPPED — missing or unknown convId for msg=${data?.msgId || '-'}`)
        return
      }
      // Consume this synchronously, before React defers the state updater. Clearing
      // it inside the updater races the executor re-arming it for the following
      // round, which can make a later turn overwrite the current one.
      const startsNewTurn = startNewAssistantTurns.current.delete(id)
      const nextText = data.text || ''
      const currentLast =
        snap.current.conversations[id]?.messages[
          snap.current.conversations[id].messages.length - 1
        ]
      if (startsNewTurn || currentLast?.role !== 'assistant' || !currentLast.streaming) {
        streamSnapshotLengths.current.delete(id)
      }
      const previousLength = streamSnapshotLengths.current.get(id) || 0
      if (nextText.length < previousLength) return
      streamSnapshotLengths.current.set(id, nextText.length)

      const parsed = parseAgentActions(nextText)
      const hasProtocolProgress =
        !parsed.hasDone &&
        parsed.actions.some((action) => action.type === 'note' || action.type !== 'done')
      const preview = hasProtocolProgress
        ? structuredAgentTurn(parsed.actions, permissionRef.current, true).message
        : null
      setConversations(prev => {
        const conv = prev[id]
        if (!conv) return prev
        const msgs = [...conv.messages]
        const last = msgs[msgs.length - 1]
        if (last && last.role === 'assistant' && !startsNewTurn) {
          msgs[msgs.length - 1] = preview
            ? { ...last, ...preview }
            : { ...last, text: nextText, streaming: true }
        } else {
          msgs.push(preview || { role: 'assistant', text: nextText, streaming: true })
        }
        return { ...prev, [id]: { ...conv, messages: msgs } }
      })
    }))

    trackListener(window.parallax?.onResponse((data: any) => {
      const rawText = data.text || ''
      wrongConvRetry.current = 0
      // The extension stamps every reply with the conversation whose tab produced
      // it. Never guess from whichever task happens to be selected or sending.
      const routeId = typeof data?.convId === 'string' ? data.convId : ''
      wlog(`onResponse ← ${prev(rawText)} url=${data.url || '-'} → route conv=${routeId || '(NONE — response will be DROPPED)'}`)
      if (!routeId || !snap.current.conversations[routeId]) {
        wlog('onResponse DROPPED — missing or unknown convId')
        return
      }
      streamSnapshotLengths.current.delete(routeId)
      clearAgentContinuations(routeId)
      function updateOrAdd(convId: string) {
        const startsNewTurn = startNewAssistantTurns.current.delete(convId)
        setConversations(prev => {
          const conv = prev[convId]
          if (!conv) return prev
          const msgs = [...conv.messages]
          const last = msgs[msgs.length - 1]
          if (last && last.role === 'assistant' && !startsNewTurn) {
            msgs[msgs.length - 1] = {
              ...last,
              text: rawText,
              toolCalls: data.toolCalls || '',
              streaming: false,
              notes: undefined,
              calls: undefined,
              steps: undefined,
            }
          } else {
            msgs.push({ role: 'assistant', text: rawText, toolCalls: data.toolCalls || '', streaming: false })
          }
          return {
            ...prev,
            [convId]: {
              ...conv,
              messages: msgs,
              unread: convId !== snap.current.currentConvId,
              updatedAt: Date.now(),
            },
          }
        })
      }
      // Route by the identity the extension stamped on the reply (the conversation
      // whose dedicated tab produced it). Nothing to infer, so a reply cannot land
      // in the wrong chat.
      const targetId = routeId
      // Parse BEFORE committing the completed raw message. A tool turn used to
      // render once as protocol text and then render again as structured cards,
      // producing the visible "can't parse" flash and layout twitch.
      const continues = targetId ? handleAgentResponse(targetId, rawText) : false
      if (targetId && !continues) updateOrAdd(targetId)
      const canonical = canonicalChatgptUrl(data.url)
      if (canonical && targetId) {
        chatgptUrlByConv.current[targetId] = canonical
        setConversations(prev => {
          if (!prev[targetId]) return prev
          return { ...prev, [targetId]: { ...prev[targetId], chatgptUrl: canonical } }
        })
      }
      // Drive the agent loop off the completed response. If it's a normal
      // (non-protocol) reply, stop sending and leave it displayed as-is.
      if (continues) return
      setSending(false, 'response had no tool actions', targetId)
      if (!targetId || activeSendConv.current === targetId) activeSendConv.current = null
      scheduleQueuedUserSend()
    }))

    trackListener(window.parallax?.onError((data: any) => {
      const msg = data?.message || data?.text || 'Unknown error'
      wlog(`onError ← "${msg}" url=${data?.url || '-'}`)
      setErrorMessage(msg)
      setTimeout(() => setErrorMessage(null), 8000)
      const continuationMsgId =
        data?.msgId ||
        (lastOutgoing.current?.silent ? lastOutgoing.current.msgId : undefined)
      const failedContinuation = continuationMsgId
        ? pendingAgentContinuations.current.get(continuationMsgId)
        : undefined
      if (failedContinuation) {
        wlog(
          `agent continuation failed conv=${failedContinuation.convId}; retrying`,
        )
        retryAgentContinuation(failedContinuation)
        return
      }
      pendingText.current = null
      pendingWire.current = undefined
      pendingModel.current = undefined
      pendingIntelligence.current = undefined
      navigatingToUrl.current = null
      const failedConvId =
        typeof data?.convId === 'string' && snap.current.conversations[data.convId]
          ? data.convId
          : ''
      setSending(false, 'response error', failedConvId || undefined)
      const failedMsgId =
        data?.msgId ||
        (!lastOutgoing.current?.silent ? lastOutgoing.current?.msgId : undefined)
      if (failedMsgId) pendingProtocolBootstraps.current.delete(failedMsgId)
      if (
        failedConvId &&
        failedMsgId &&
        unconfirmedUserMessages.current.has(failedMsgId)
      ) {
        unconfirmedUserMessages.current.delete(failedMsgId)
        setMessageDelivery(failedConvId, failedMsgId, 'failed')
      }
      if (failedConvId) pendingAttachments.current.delete(failedConvId)
      const canonical = canonicalChatgptUrl(data.url)
      if (canonical && failedConvId) {
        chatgptUrlByConv.current[failedConvId] = canonical
        if (failedConvId) {
          setConversations(prev => {
            if (!prev[failedConvId]) return prev
            return { ...prev, [failedConvId]: { ...prev[failedConvId], chatgptUrl: canonical } }
          })
        }
      }
      if (!failedConvId || activeSendConv.current === failedConvId) activeSendConv.current = null
      scheduleQueuedUserSend()
    }))

    // The page refused to type because the tab was on a different conversation.
    // Navigate to this thread's stored ChatGPT link, then replay the message. This
    // is what guarantees a message can never land in the wrong chat.
    trackListener(window.parallax?.onWrongConversation?.((data: any) => {
      const pendingContinuation =
        (data?.msgId
          ? pendingAgentContinuations.current.get(data.msgId)
          : undefined) ||
        (lastOutgoing.current?.silent
          ? pendingAgentContinuations.current.get(lastOutgoing.current.msgId)
          : undefined)
      const out = pendingContinuation
        ? {
            convId: pendingContinuation.convId,
            msgId: pendingContinuation.msgId,
            text: '',
            wire: pendingContinuation.wire,
            model: undefined,
            intelligence: undefined,
            silent: true,
          }
        : lastOutgoing.current
      // Where this turn SHOULD be. The extension reports it, but the desktop is the
      // real owner of that link — fall back to the thread's stored URL so a missing
      // `expected` can't turn a recoverable navigation into a dead end.
      const convId = out?.convId || activeSendConv.current || snap.current.currentConvId
      const expected =
        data?.expected || (convId ? snap.current.conversations[convId]?.chatgptUrl : null) || null
      wlog(`wrong_conversation ← tab on ${data?.actual || '?'} — navigating back to ${expected || '?'} and retrying`)
      if (!out || !expected || wrongConvRetry.current >= 3) {
        wrongConvRetry.current = 0
        if (pendingContinuation) {
          setErrorMessage(
            "The browser tab keeps leaving this task. Parallax is holding the result and will keep retrying it.",
          )
          retryAgentContinuation(pendingContinuation, 1000)
          return
        }
        setSending(false, 'wrong_conversation — gave up', convId)
        setErrorMessage(
          expected
            ? "Couldn't get that ChatGPT tab back to this thread's conversation. Send again to retry."
            : 'This thread has no ChatGPT conversation linked yet. Send again to start one.',
        )
        activeSendConv.current = null
        scheduleQueuedUserSend()
        return
      }
      wrongConvRetry.current += 1
      // Re-arm the existing navigate → ready → flush machinery.
      pendingText.current = out.text || ''
      pendingWire.current = out.wire
      pendingModel.current = out.model
      pendingIntelligence.current = out.intelligence
      navigatingToUrl.current = expected
      if (convId) delete chatgptUrlByConv.current[convId]
      window.parallax?.navigate(expected, convId || undefined)
    }))

    trackListener(window.parallax?.onDebugResult((data: any) => {
      let body = ''
      if (data.data?.html) {
        body = data.data.html
      } else if (data.data?.selectors) {
        body = '=== SELECTOR TEST ===\n\n'
        for (const [key, results] of Object.entries(data.data.selectors)) {
          body += `--- ${key} ---\n`
          for (const r of results as any[]) {
            body += `  ${r.selector}\n    → ${r.match || 'NO MATCH'}\n`
          }
          body += '\n'
        }
        if (data.data.selectors.other?.buttonsOnPage) {
          body += '--- ALL BUTTONS ---\n'
          for (const b of data.data.selectors.other.buttonsOnPage) {
            body += `  ${b}\n`
          }
        }
      } else {
        body = JSON.stringify(data.data, null, 2)
      }
      const id = snap.current.currentConvId
      if (id) {
        addMessageToConv(id, 'assistant', {
          text: '',
          toolCalls: '',
          _debug: true,
        })
      }
    }))
    window.parallax?.ready()
    return () => {
      for (const cleanup of listenerCleanups) cleanup()
      for (const timer of continuationRetryTimers.current.values()) clearTimeout(timer)
      continuationRetryTimers.current.clear()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const currentConv = useCallback(() => {
    return currentConvId ? conversations[currentConvId] : null
  }, [conversations, currentConvId])

  const save = useCallback(() => {
    const s = snap.current
    window.parallax?.saveData({ conversations: s.conversations, convOrder: s.convOrder, projects: s.projects })
  }, [])

  // Create a new thread, optionally inside a project folder. Reuses an existing
  // empty draft that already targets the same folder instead of piling up drafts.
  function newConversation(folderPath?: string | null, skipSave?: boolean) {
    const { conversations, convOrder } = snap.current
    const folder = folderPath ?? null
    const existingDraft = convOrder
      .map(id => conversations[id])
      .find(c => c && !c.archived && c.messages.length === 0 && (c.folderPath ?? null) === folder)
    if (existingDraft) {
      setConversations(prev => {
        const existing = prev[existingDraft.id]
        if (!existing?.unread) return prev
        return { ...prev, [existingDraft.id]: { ...existing, unread: false } }
      })
      setCurrentConvId(existingDraft.id)
      return
    }
    const id = 'conv-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)
    const conv: Conversation = { id, title: 'New chat', messages: [], chatgptUrl: null, folderPath: folder, updatedAt: Date.now() }
    setConversations(prev => ({ ...prev, [id]: conv }))
    setConvOrder(prev => [...prev, id])
    setCurrentConvId(id)
    if (!skipSave) setTimeout(save, 0)
  }

  // Add a project folder via the native picker, then start a thread inside it.
  async function addProject() {
    const res = await window.parallax?.selectFolder?.()
    if (!res?.ok || !res.path) return
    const path: string = res.path
    setProjects(prev => (prev.includes(path) ? prev : [...prev, path]))
    setTimeout(() => {
      newConversation(path)
      setTimeout(save, 0)
    }, 0)
  }

  function removeProject(path: string) {
    const current = snap.current
    const archivedIds = new Set(
      current.convOrder.filter(id => current.conversations[id]?.folderPath === path),
    )
    const updatedConversations = { ...current.conversations }
    for (const id of archivedIds) {
      updatedConversations[id] = { ...updatedConversations[id], archived: true }
    }
    const updatedProjects = current.projects.filter(project => project !== path)

    setConversations(updatedConversations)
    setProjects(updatedProjects)
    if (current.currentConvId && archivedIds.has(current.currentConvId)) {
      const next = current.convOrder.find(
        id => !archivedIds.has(id) && updatedConversations[id] && !updatedConversations[id].archived,
      )
      setCurrentConvId(next ?? null)
    }
    void window.parallax?.saveData({
      conversations: updatedConversations,
      convOrder: current.convOrder,
      projects: updatedProjects,
    })
  }

  function switchConversation(id: string, skipNavigate?: boolean) {
    setConversations(prev => {
      const conv = prev[id]
      if (!conv?.unread) return prev
      return { ...prev, [id]: { ...conv, unread: false } }
    })
    setCurrentConvId(id)
    const s = snap.current.conversations[id]
    // Never navigate the ChatGPT tab while a send is in flight: it aborts the
    // streaming response and can dump the active thread onto a fresh "new chat".
    // The visible thread still switches; the tab catches up on the next send.
    if (sendingRef.current) return
    const actual = chatgptUrlByConv.current[id]
    if (!skipNavigate && s?.chatgptUrl && s.chatgptUrl !== actual) {
      navigatingToUrl.current = s.chatgptUrl
      window.parallax?.navigate(s.chatgptUrl, id)
    } else if (s?.chatgptUrl === actual) {
      navigatingToUrl.current = null
    }
  }

  function editMessage(messageId: string, text: string, originalText = '') {
    const trimmed = text.trim()
    const convId = snap.current.currentConvId
    const conv = convId ? snap.current.conversations[convId] : undefined
    if (!trimmed || !convId || !conv || sendingRef.current) return
    let messageIndex = conv.messages.findIndex(
      (message) => message.role === 'user' && message.msgId === messageId,
    )
    if (messageIndex < 0 && messageId.startsWith('legacy:')) {
      const legacyIndex = Number(messageId.slice('legacy:'.length))
      if (
        Number.isInteger(legacyIndex) &&
        conv.messages[legacyIndex]?.role === 'user'
      ) {
        messageIndex = legacyIndex
      }
    }
    if (messageIndex < 0 && originalText) {
      messageIndex = conv.messages.findIndex(
        (message) => message.role === 'user' && message.text === originalText,
      )
    }
    if (messageIndex < 0) return

    const original = conv.messages[messageIndex]
    if (trimmed === original.text) return
    const userIndex =
      conv.messages.slice(0, messageIndex + 1).filter((message) => message.role === 'user').length - 1
    const firstUserMessage = userIndex === 0
    const folderBase = conv.folderPath
      ? conv.folderPath.split('/').filter(Boolean).pop() || null
      : null
    const wireText =
      firstUserMessage && needsHarnessBootstrap(trimmed)
        ? composeWireMessage(trimmed, folderBase)
        : undefined
    const nextMsgId = newMessageId()

    setConversations((previous) => {
      const current = previous[convId]
      if (!current) return previous
      const messages = current.messages.slice(0, messageIndex + 1)
      messages[messageIndex] = {
        ...messages[messageIndex],
        text: trimmed,
        msgId: nextMsgId,
        delivery: 'pending',
      }
      return {
        ...previous,
        [convId]: {
          ...current,
          title:
            firstUserMessage
              ? trimmed.length > 40
                ? `${trimmed.slice(0, 40)}…`
                : trimmed
              : current.title,
          messages,
          unread: false,
          updatedAt: Date.now(),
        },
      }
    })

    clearAgentContinuations(convId)
    streamSnapshotLengths.current.delete(convId)
    startNewAssistantTurns.current.delete(convId)
    activeSendConv.current = convId
    unconfirmedUserMessages.current.add(nextMsgId)
    lastOutgoing.current = {
      convId,
      msgId: nextMsgId,
      text: trimmed,
      wire: wireText,
      silent: false,
    }
    setSending(true, 'edited message dispatched', convId)
    wlog(`edit → conv=${convId} userIndex=${userIndex} ${prev(trimmed)}`)
    window.parallax?.editMessage?.({
      convId,
      msgId: nextMsgId,
      text: trimmed,
      wireText,
      originalText: original.text,
      userIndex,
      expectUrl: conv.chatgptUrl || undefined,
    })
  }

  function send(
    text: string,
    model?: string,
    intelligence?: string,
    context?: string,
    attachments?: OutgoingAttachment[],
    existingMsgId?: string,
    existingWire?: string,
    targetConvId?: string,
  ) {
    if (!text) return
    const conv = targetConvId
      ? snap.current.conversations[targetConvId]
      : currentConv()
    const intendedConvId = conv?.id ?? targetConvId ?? currentConvId
    if (!intendedConvId || !conv) return
    if (sendingRef.current && !existingMsgId) {
      const msgId = newMessageId()
      queuedUserSends.current.push({
        convId: intendedConvId,
        msgId,
        text,
        model,
        intelligence,
        context,
        attachments,
      })
      setQueuedMessageCounts((counts) => ({
        ...counts,
        [intendedConvId]: (counts[intendedConvId] || 0) + 1,
      }))
      wlog(`user message QUEUED conv=${intendedConvId} ${prev(text)}`)
      return
    }
    if (sendingRef.current) return
    // Anchor this turn to the sending thread so its reply routes back here even if
    // the user switches chats while it streams.
    activeSendConv.current = intendedConvId
    const convId = activeSendConv.current
    const msgId = existingMsgId || newMessageId()
    if (convId) streamSnapshotLengths.current.delete(convId)

    const folderBase = conv?.folderPath ? conv.folderPath.split('/').filter(Boolean).pop() || null : null
    const outgoing = context ? `${text}\n\n${context}` : text
    const shouldBootstrap =
      (!conv?.protocolReady || conv.protocolVersion !== HARNESS_PROTOCOL_VERSION) &&
      needsHarnessBootstrap(text, context)
    const wire = existingWire ?? (
      shouldBootstrap
        ? composeWireMessage(outgoing, folderBase)
        : context
          ? outgoing
          : undefined
    )
    if (shouldBootstrap && convId) {
      pendingProtocolBootstraps.current.set(msgId, convId)
    }

    if (!existingMsgId && convId) {
      const pending = attachments || pendingAttachments.current.get(convId)
      unconfirmedUserMessages.current.add(msgId)
      addMessageToConv(convId, 'user', {
        text,
        msgId,
        attachments: pending,
        delivery: wsOfflineRef.current ? 'queued' : 'pending',
      })
    } else if (
      existingMsgId &&
      convId &&
      !conv.messages.some((message) => message.msgId === msgId)
    ) {
      unconfirmedUserMessages.current.add(msgId)
      addMessageToConv(convId, 'user', {
        text,
        msgId,
        attachments,
        delivery: 'pending',
      })
    } else if (existingMsgId && convId) {
      unconfirmedUserMessages.current.add(msgId)
      setMessageDelivery(convId, msgId, 'pending')
    }

    // Extension offline → don't navigate/new-chat into a dead end (that's what made
    // the app "ask" for a new chat). Hold this message on ITS thread and replay it
    // when the link returns, so the user continues the SAME conversation.
    if (wsOfflineRef.current) {
      queuedSend.current = { convId, msgId, text, model, intelligence, context, wire, attachments }
      setQueuedNotice(text)
      setSending(true, 'extension offline — send queued', convId)
      wlog(`send QUEUED (extension offline) conv=${convId || '(none)'} ${prev(text)}`)
      return
    }

    if (attachments?.length && convId) {
      pendingAttachments.current.set(convId, attachments)
      window.parallax?.sendFiles(convId, attachments)
    }

    // Just send. Each conversation owns a dedicated tab, and the extension opens it
    // on demand (at this thread's stored link) if it doesn't exist yet. There is no
    // longer anything to navigate, so the old new_chat → wait-for-ready → flush
    // dance is gone — along with its 5s race, which fired before a cold ChatGPT tab
    // had loaded and produced "No content script connected".
    wlog(`send → conv=${convId || '(none)'} ${prev(text)} link=${conv?.chatgptUrl || '(new tab)'}`)
    setSending(true, 'send dispatched', convId)
    const confirmed = convId ? confirmedSelectionByConv.current[convId] : undefined
    const modelChanged = Boolean(model && confirmed?.model !== model)
    const modelToApply = modelChanged ? model : undefined
    const intelligenceToApply =
      intelligence && (modelChanged || confirmed?.intelligence !== intelligence)
        ? intelligence
        : undefined
    // Remember the payload so a refusal (tab on the wrong chat) can replay it
    // after we navigate, and pass the thread's stored link so the page can verify.
    lastOutgoing.current = {
      convId,
      msgId,
      text,
      wire,
      model: modelToApply,
      intelligence: intelligenceToApply,
      silent: false,
    }
    window.parallax?.send(
      text,
      modelToApply,
      intelligenceToApply,
      wire,
      false,
      conv?.chatgptUrl || undefined,
      convId || undefined,
      msgId,
    )
  }
  // Keep a stable handle so the reconnect effect can replay a queued send without
  // closing over a stale `send`.
  sendRef.current = send

  // Extension came back online → replay the message the user queued while it was
  // offline, into the same thread. This is what lets them "just continue" instead
  // of starting a new chat.
  useEffect(() => {
    if (wsStatus.status !== 'connected') return
    for (const [convId, files] of queuedFiles.current) {
      window.parallax?.sendFiles(convId, files)
    }
    queuedFiles.current.clear()
    const continuations = [...queuedAgentContinuations.current.values()]
    queuedAgentContinuations.current.clear()
    for (const continuation of continuations) {
      dispatchAgentContinuation(continuation)
    }
    const q = queuedSend.current
    if (!q) {
      scheduleQueuedUserSend()
      return
    }
    queuedSend.current = null
    setQueuedNotice(null)
    wlog(`reconnected → replaying queued send into conv=${q.convId || '(current)'}`)
    setSending(false, 'extension reconnected — replay queued send', q.convId)
    setTimeout(
      () => sendRef.current(
        q.text,
        q.model,
        q.intelligence,
        q.context,
        q.attachments,
        q.msgId,
        q.wire,
        q.convId || undefined,
      ),
      0,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsStatus])

  // ── Agent loop ────────────────────────────────────────────────────────────
  // Called on every completed ChatGPT response. A reply with tool actions is an
  // act turn: render notes + tool-call cards, apply the permission gate, run the
  // allowed tools, feed results back. A reply with NO tool actions is the finished
  // answer (plain prose). Returns true iff more turns follow (loop stays busy).
  function handleAgentResponse(convId: string, rawText: string): boolean {
    const { actions, hasDone } = parseAgentActions(rawText)
    const kinds = actions.map(a => a.type).join(',') || '(none)'
    wlog(`parse conv=${convId} → actions=[${kinds}] hasDone=${hasDone}`)

    // ‹plx:done› is terminal and takes PRECEDENCE. If the model wrapped a final
    // answer in it, we stop here — even if the same scraped blob also contains
    // action tags (stale echoes of earlier turns, or the model mixing act+done).
    // Without this, those echoed tags get re-executed and the harness "replies"
    // to the model again after it already finished.
    if (hasDone) {
      agentLoopCounts.current.delete(convId)
      protocolRetryCounts.current.delete(convId)
      return false
    }

    const parsedToolActions = actions.filter(
      (action): action is ToolAction =>
        action.type === 'read' ||
        action.type === 'list' ||
        action.type === 'search' ||
        action.type === 'run' ||
        action.type === 'write',
    )

    if (parsedToolActions.length === 0) {
      const protocolLike = /(?:^|[<{‹⟨«〈＜〈])\s*\/?\s*plx\s*:/im.test(rawText)
      const partialDone =
        /(?:^|[<{‹⟨«〈＜〈])\s*plx:done\b/im.test(rawText)
      const retryCount = protocolRetryCounts.current.get(convId) || 0
      if (protocolLike && retryCount < 2) {
        protocolRetryCounts.current.set(convId, retryCount + 1)
        setConversations(prev => {
          const conv = prev[convId]
          if (!conv) return prev
          const msgs = [...conv.messages]
          const last = msgs[msgs.length - 1]
          const repair: Message = {
            role: 'assistant',
            text: '',
            streaming: true,
            notes: [
              partialDone
                ? 'The final answer was interrupted, so I’m recovering it.'
                : 'The action response was interrupted, so I’m retrying that step.',
            ],
          }
          if (last && last.role === 'assistant') msgs[msgs.length - 1] = { ...last, ...repair }
          else msgs.push(repair)
          return { ...prev, [convId]: { ...conv, messages: msgs } }
        })
        const wire =
          '{plx:result kind="protocol" status="error"}\n' +
          (partialDone
            ? 'Your final answer was truncated. Re-emit the complete answer now in one concise {plx:done} block. Do not run tools or add action tags.\n'
            : 'Your previous action response was incomplete. Re-emit that same action turn now with one complete {plx:note} and no more than 6 complete action tags. Do not repeat completed work.\n') +
          '{/plx:result}'
        sendAgentContinuation(convId, wire, false)
        return true
      }
      agentLoopCounts.current.delete(convId)
      protocolRetryCounts.current.delete(convId)
      return false
    }
    protocolRetryCounts.current.delete(convId)

    const {
      toolActions,
      hasApprovalAction,
      message: structured,
    } = structuredAgentTurn(actions, permissionRef.current, false)

    const startsNewTurn = startNewAssistantTurns.current.delete(convId)
    setConversations(prev => {
      const conv = prev[convId]
      if (!conv) return prev
      const msgs = [...conv.messages]
      const last = msgs[msgs.length - 1]
      if (last && last.role === 'assistant' && !startsNewTurn) {
        msgs[msgs.length - 1] = { ...last, ...structured }
      } else {
        msgs.push(structured)
      }
      return { ...prev, [convId]: { ...conv, messages: msgs } }
    })

    const loopCount = (agentLoopCounts.current.get(convId) || 0) + 1
    agentLoopCounts.current.set(convId, loopCount)
    if (loopCount > MAX_AGENT_LOOP) {
      const limitMessage =
        'The action-round limit was reached. Stop running actions and return the best available answer now.'
      setConversations(prev => {
        const conv = prev[convId]
        if (!conv) return prev
        const msgs = [...conv.messages]
        const last = msgs[msgs.length - 1]
        if (!last?.calls) return prev
        msgs[msgs.length - 1] = {
          ...last,
          calls: last.calls.map((call) => ({
            ...call,
            status: 'blocked',
            result: limitMessage,
          })),
        }
        return { ...prev, [convId]: { ...conv, messages: msgs } }
      })
      agentLoopCounts.current.delete(convId)
      const wire =
        '{plx:result kind="protocol" status="error"}\n' +
        `${limitMessage} Reply with one complete {plx:done} block and no action tags.\n` +
        '{/plx:result}'
      sendAgentContinuation(convId, wire, true)
      return true
    }

    // Manual asks before every shell command/write. Auto-review follows the
    // planner's explicit review flag and otherwise continues automatically.
    if (hasApprovalAction) {
      setPendingApproval({ convId, actions: toolActions })
      return true
    }

    // Unflagged Auto-review actions and all Full-access actions execute immediately.
    setTimeout(() => {
      void executeTurn(convId, toolActions, () => ({ run: true }))
    }, 0)
    return true
  }

  type Disposition = { run: true } | { run: false; status: 'blocked' | 'denied'; content: string }

  // Execute a turn's tool actions per `decide`, update the cards, and feed the
  // combined ‹plx:result› blocks back into the thread as an invisible turn.
  async function executeTurn(convId: string, toolActions: ToolAction[], decide: (a: ToolAction) => Disposition) {
    const decisions = toolActions.map(decide)
    const runIdx: number[] = []
    const completedIdx: number[] = []
    const results: ToolResult[] = new Array(toolActions.length)
    const cardStatus: AgentCall['status'][] = new Array(toolActions.length)

    decisions.forEach((d, i) => {
      if (d.run) {
        runIdx.push(i)
      } else {
        results[i] = { status: 'error', content: d.content }
        cardStatus[i] = d.status
        completedIdx.push(i)
      }
    })

    const publishResults = (indices: number[]) => {
      if (indices.length === 0) return
      const ready = new Set(indices)
      setConversations(prev => {
        const conv = prev[convId]
        if (!conv) return prev
        const msgs = [...conv.messages]
        const last = msgs[msgs.length - 1]
        if (!last || last.role !== 'assistant' || !last.calls) return prev
        const calls = last.calls.map((call, index) => (
          ready.has(index)
            ? {
                ...call,
                status: cardStatus[index] || 'error',
                result: results[index]?.content || '',
                diff: results[index]?.diff || call.diff,
              }
            : call
        ))
        msgs[msgs.length - 1] = { ...last, calls }
        return { ...prev, [convId]: { ...conv, messages: msgs } }
      })
    }

    publishResults(completedIdx)

    const cwd = snap.current.conversations[convId]?.folderPath || null
    const executeAction = async (origIdx: number) => {
      const executionId = newMessageId()
      activeToolExecutions.current.set(executionId, { convId, callIndex: origIdx })
      const action = toolActions[origIdx]
      if (action.type === 'run') {
        // Make the disclosure usable in the same render that starts the process.
        // Waiting for the first stdout chunk left a completed-looking empty panel
        // when the command was quiet or Electron delayed the progress IPC paint.
        updateToolCall(convId, origIdx, {
          status: 'running',
          result: `$ ${action.command}\n`,
        })
      }
      const startedAt = performance.now()
      wlog(`tool start conv=${convId} action=${origIdx + 1}/${toolActions.length}`)
      let result: ToolResult
      try {
        const response = await window.parallax?.agentExec?.({
          cwd,
          actions: [toolActions[origIdx]],
          executionId,
        })
        result = (response?.results as ToolResult[] | undefined)?.[0] || {
          status: 'error',
          content: 'No result.',
        }
      } catch (err: any) {
        result = {
          status: 'error',
          content: `Executor failed: ${err?.message || err}`,
        }
      } finally {
        activeToolExecutions.current.delete(executionId)
      }
      wlog(
        `tool complete conv=${convId} action=${origIdx + 1}/${toolActions.length} ` +
        `status=${result.status} elapsed=${Math.round(performance.now() - startedAt)}ms`,
      )
      results[origIdx] = result
      cardStatus[origIdx] = result.status || 'error'
      publishResults([origIdx])
    }

    // Actions emitted in the same turn cannot depend on one another's unseen
    // results. Run consecutive read-only actions together, while preserving every
    // state-changing action as an ordered barrier.
    let position = 0
    while (position < runIdx.length) {
      const origIdx = runIdx[position]
      if (isNonReadAction(toolActions[origIdx])) {
        await executeAction(origIdx)
        position += 1
        continue
      }

      const readBatch: number[] = []
      while (
        position < runIdx.length &&
        !isNonReadAction(toolActions[runIdx[position]])
      ) {
        readBatch.push(runIdx[position])
        position += 1
      }
      await Promise.all(readBatch.map(executeAction))
    }

    const wire =
      `${formatAgentResults(toolActions, results)}\n\n` +
      '{plx:result kind="guidance" status="ok"}\n' +
      'Answer now if these results are sufficient. For a repository overview, do not read equivalent files from every sibling project; inspect only a missing fact that would materially change the answer.\n' +
      '{/plx:result}'
    sendAgentContinuation(convId, wire, true)
  }

  // Abort the in-flight turn and clear every latch that keeps `sending` true.
  // The composer's send button turns into a Stop button that calls this, so a
  // response that never arrives (or a stalled agent loop) can't wedge the UI.
  function stopSending() {
    pendingText.current = null
    pendingWire.current = undefined
    pendingModel.current = undefined
    pendingIntelligence.current = undefined
    navigatingToUrl.current = null
    const stopConv =
      activeSendConv.current ||
      workingConvIdsRef.current.values().next().value ||
      snap.current.currentConvId ||
      ''
    if (stopConv) {
      startNewAssistantTurns.current.delete(stopConv)
      agentLoopCounts.current.delete(stopConv)
      protocolRetryCounts.current.delete(stopConv)
      streamSnapshotLengths.current.delete(stopConv)
      clearAgentContinuations(stopConv)
    }
    queuedSend.current = null
    setQueuedNotice(null)
    setPendingApproval(null)
    setSending(false, 'user pressed Stop', stopConv)
    setErrorMessage(null)
    // Aim the stop at the tab that's actually generating for this thread.
    if (stopConv) pendingAttachments.current.delete(stopConv)
    try { window.parallax?.stopGenerating?.(stopConv) } catch {}
    activeSendConv.current = null
    scheduleQueuedUserSend()
  }

  function takeQueuedUserSend(msgId: string): QueuedUserSend | null {
    const index = queuedUserSends.current.findIndex((queued) => queued.msgId === msgId)
    if (index < 0) return null
    const [queued] = queuedUserSends.current.splice(index, 1)
    setQueuedMessageCounts((counts) => {
      const remaining = Math.max(0, (counts[queued.convId] || 0) - 1)
      const updated = { ...counts }
      if (remaining) updated[queued.convId] = remaining
      else delete updated[queued.convId]
      return updated
    })
    return queued
  }

  function editQueuedMessage(msgId: string): string | null {
    const queued = takeQueuedUserSend(msgId)
    if (!queued) return null
    wlog(`queued message restored conv=${queued.convId} ${prev(queued.text)}`)
    return queued.text
  }

  function deleteQueuedMessage(msgId: string) {
    const queued = takeQueuedUserSend(msgId)
    if (queued) wlog(`queued message deleted conv=${queued.convId} ${prev(queued.text)}`)
  }

  function scheduleQueuedUserSend() {
    setTimeout(() => {
      if (sendingRef.current || wsOfflineRef.current) return
      let next = queuedUserSends.current.shift()
      while (next && !snap.current.conversations[next.convId]) {
        next = queuedUserSends.current.shift()
      }
      if (!next) return
      setQueuedMessageCounts((counts) => {
        const remaining = Math.max(0, (counts[next!.convId] || 0) - 1)
        const updated = { ...counts }
        if (remaining) updated[next!.convId] = remaining
        else delete updated[next!.convId]
        return updated
      })
      sendRef.current(
        next.text,
        next.model,
        next.intelligence,
        next.context,
        next.attachments,
        next.msgId,
        undefined,
        next.convId,
      )
    }, 0)
  }

  function approvePending() {
    const p = pendingApproval
    if (!p) return
    setPendingApproval(null)
    void executeTurn(p.convId, p.actions, () => ({ run: true }))
  }

  function denyPending() {
    const p = pendingApproval
    if (!p) return
    setPendingApproval(null)
    void executeTurn(p.convId, p.actions, () => ({
      run: false,
      status: 'denied',
      content: 'Denied by the user. Do not retry this action; find another approach or ask.',
    }))
  }

  // Archive / restore threads. Archiving keeps the data (unlike delete) but removes
  // the thread from all everyday navigation; Settings is the recovery surface.
  function setArchived(ids: string[], archived: boolean) {
    if (!ids.length) return
    const idSet = new Set(ids)
    setConversations(prev => {
      const updated = { ...prev }
      for (const id of ids) {
        if (updated[id]) updated[id] = { ...updated[id], archived }
      }
      setTimeout(() => {
        const s = snap.current
        window.parallax?.saveData({ conversations: updated, convOrder: s.convOrder, projects: s.projects })
      }, 0)
      return updated
    })
    // If we archived the thread currently in view, move selection off it.
    if (archived) {
      const cur = snap.current.currentConvId
      if (cur && idSet.has(cur)) {
        const next = snap.current.convOrder.find(
          c => !idSet.has(c) && snap.current.conversations[c] && !snap.current.conversations[c].archived,
        )
        setCurrentConvId(next ?? null)
      }
    }
  }
  const archiveConv = (ids: string[]) => setArchived(ids, true)
  const unarchiveConv = (ids: string[]) => setArchived(ids, false)

  function renameConv(ids: string[], name: string) {
    if (!name.trim()) return
    const trimmedName = name.trim()
    setConversations(prev => {
      const updated = { ...prev }
      ids.forEach((id, i) => {
        const conv = updated[id]
        if (!conv) return
        updated[id] = {
          ...conv,
          title: i === 0 ? trimmedName : `${trimmedName} #${i}`,
        }
      })
      setTimeout(() => {
        const s = snap.current
        window.parallax?.saveData({ conversations: updated, convOrder: s.convOrder, projects: s.projects })
      }, 0)
      return updated
    })
  }

  function deleteConv(ids: string[]) {
    const idSet = new Set(ids)
    const oldCurrent = snap.current.currentConvId
    setConvOrder(prev => prev.filter(c => !idSet.has(c)))
    setConversations(prev => {
      const rest = Object.fromEntries(Object.entries(prev).filter(([id]) => !idSet.has(id)))
      setTimeout(() => {
        const s = snap.current
        window.parallax?.saveData({ conversations: rest, convOrder: s.convOrder, projects: s.projects })
      }, 0)
      return rest
    })
    if (oldCurrent && idSet.has(oldCurrent)) {
      const remaining = snap.current.convOrder.filter(c => !idSet.has(c))
      setCurrentConvId(remaining.length > 0 ? remaining[0] : null)
    }
  }

  function sendFiles(convId: string, files: { name: string; data: string; mime: string }[]) {
    if (!convId || files.length === 0) return
    pendingAttachments.current.set(
      convId,
      [...(pendingAttachments.current.get(convId) || []), ...files],
    )
    if (wsOfflineRef.current) {
      queuedFiles.current.set(convId, [...(queuedFiles.current.get(convId) || []), ...files])
      return
    }
    window.parallax?.sendFiles(convId, files)
  }

  function setFolderPath(convId: string, folderPath: string | null) {
    // Registering a folder on a thread also makes it a project in the sidebar.
    if (folderPath) setProjects(prev => (prev.includes(folderPath) ? prev : [...prev, folderPath]))
    setConversations(prev => {
      if (!prev[convId]) return prev
      const updated = { ...prev, [convId]: { ...prev[convId], folderPath } }
      setTimeout(() => {
        const s = snap.current
        window.parallax?.saveData({ conversations: updated, convOrder: s.convOrder, projects: s.projects })
      }, 0)
      return updated
    })
  }

  // Open the native folder picker and set it as the current thread's workspace.
  async function chooseFolder(convId: string) {
    const res = await window.parallax?.selectFolder?.()
    if (res?.ok && res.path) setFolderPath(convId, res.path)
  }

  function deleteAllConversations() {
    queuedSend.current = null
    queuedUserSends.current = []
    setQueuedMessageCounts({})
    setConversations({})
    setConvOrder([])
    setCurrentConvId(null)
    setTimeout(() => {
      window.parallax?.saveData({ conversations: {}, convOrder: [], projects: snap.current.projects })
    }, 0)
  }

  return {
    conversations,
    convOrder,
    currentConvId,
    currentConv: currentConv(),
    sending,
    currentConversationSending: currentConvId ? workingConvIds.has(currentConvId) : false,
    currentQueuedMessageCount: currentConvId ? queuedMessageCounts[currentConvId] || 0 : 0,
    currentQueuedMessages: currentConvId
      ? queuedUserSends.current
          .filter((queued) => queued.convId === currentConvId)
          .map((queued) => ({ id: queued.msgId, text: queued.text }))
      : [],
    workingConversationIds: workingConvIds,
    dataLoaded,
    errorMessage,
    // Only an explicit "disconnected" counts as offline — the composer warns and
    // queues on this, but NOT on the transient "waiting" state at startup/reload.
    extensionDisconnected: extensionWarningVisible,
    // The message the user typed while offline, held to auto-send on reconnect.
    queuedNotice,
    serverStatus,
    wsStatus,
    chatgptStatus,
    gptModel,
    availableModels,
    intelligenceLevel,
    selectionStatus,
    projects,
    permissionLevel,
    pendingApproval,
    setGptModel,
    setIntelligenceLevel,
    setPermissionLevel,
    approvePending,
    denyPending,
    stopSending,
    editQueuedMessage,
    deleteQueuedMessage,
    newConversation: (folderPath?: string | null) => newConversation(folderPath),
    addProject,
    removeProject,
    switchConversation,
    send,
    editMessage,
    renameConv,
    deleteConv,
    archiveConv,
    unarchiveConv,
    sendFiles,
    setFolderPath,
    chooseFolder,
    deleteAllConversations,
  }
}
