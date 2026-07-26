export interface TranscriptMessage {
  role: string
  text?: string
  msgId?: string
  delivery?: string
  attachments?: unknown[]
}

const DELIVERY_RETRY_WINDOW_MS = 30_000

function messageTime(message: TranscriptMessage): number | null {
  const match = /^(\d{13})-/.exec(message.msgId || '')
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

function isLikelyDeliveryRetry(previous: TranscriptMessage, current: TranscriptMessage): boolean {
  if (previous.role !== 'user' || current.role !== 'user') return false
  if (!previous.text || previous.text !== current.text) return false
  if (previous.delivery || current.delivery) return false
  if ((previous.attachments?.length ?? 0) > 0 || (current.attachments?.length ?? 0) > 0) return false

  const previousTime = messageTime(previous)
  const currentTime = messageTime(current)
  if (previousTime === null || currentTime === null) return false

  const elapsed = currentTime - previousTime
  return elapsed >= 0 && elapsed <= DELIVERY_RETRY_WINDOW_MS
}

// Older builds gave a retry a new message identity and appended the same user text
// twice. Preserve the stored history, but render that narrow, identifiable
// transport duplicate only once. Current sends reconcile one optimistic identity.
export function visibleTranscriptMessages<T extends TranscriptMessage>(messages: T[]): T[] {
  const visible: T[] = []
  for (const message of messages) {
    const previous = visible[visible.length - 1]
    if (previous && isLikelyDeliveryRetry(previous, message)) continue
    visible.push(message)
  }
  return visible
}
