import { useEffect, useState, useRef, useMemo } from 'react'
import type { Conversation } from '../hooks/useNix'
import { cn } from '../lib/utils'

/**
 * One palette command. Supplied by the page, which owns the app's panel state —
 * the palette itself stays a dumb list so adding a command never means touching
 * this file.
 */
export interface Command {
  id: string
  label: string
  /** Section heading. Commands are shown in the order their groups first appear. */
  group?: string
  /** Shortcut shown on the right, e.g. "⌘B". Display only. */
  hint?: string
  /** Extra search terms so "panel"/"drawer"/"explorer" all find the right row. */
  keywords?: string
  run: () => void
}

interface Props {
  open: boolean
  onClose: () => void
  conversations: Record<string, Conversation>
  convOrder: string[]
  onSwitch: (id: string) => void
  commands: Command[]
}

type Item =
  | { kind: 'thread'; id: string; title: string; subtitle: string }
  | { kind: 'action'; id: string; label: string; group?: string; hint?: string; run: () => void }

export default function CommandPalette({
  open,
  onClose,
  conversations,
  convOrder,
  onSwitch,
  commands,
}: Props) {
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIdx(0)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  const items: Item[] = useMemo(() => {
    const q = query.toLowerCase().trim()
    const threads: Item[] = convOrder
      .map(id => conversations[id])
      .filter((c): c is Conversation => Boolean(c))
      .filter(c => !c.archived)
      .filter(c => !q || c.title.toLowerCase().includes(q) || c.messages.some(m => m.text.toLowerCase().includes(q)))
      .map(c => ({
        kind: 'thread' as const,
        id: c.id,
        title: c.title || 'New Chat',
        subtitle: c.messages.length > 0 ? c.messages[c.messages.length - 1].text.slice(0, 60) : 'Empty thread',
      }))

    // Match the label AND its keywords, so "panel"/"drawer"/"shell" all land.
    const actionItems: Item[] = commands
      .filter(c => !q || (c.label + ' ' + (c.keywords || '')).toLowerCase().includes(q))
      .map(c => ({
        kind: 'action' as const,
        id: c.id,
        label: c.label,
        group: c.group,
        hint: c.hint,
        // Every command closes the palette; individual commands don't repeat it.
        run: () => { c.run(); onClose() },
      }))
    // Commands first when the user is typing a command rather than hunting a thread:
    // with a query, whichever list matched more specifically should lead. Threads
    // lead on an empty query (the palette's primary job is thread switching).
    return q ? [...actionItems, ...threads] : [...threads, ...actionItems]
  }, [query, conversations, convOrder, commands, onClose])

  useEffect(() => {
    setActiveIdx(0)
  }, [query])

  useEffect(() => {
    if (!open) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, items.length - 1)) }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)) }
      if (e.key === 'Enter' && items[activeIdx]) {
        e.preventDefault()
        const item = items[activeIdx]
        if (item.kind === 'thread') { onSwitch(item.id); onClose() }
        if (item.kind === 'action') item.run()
      }
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, items, activeIdx, onSwitch, onClose])

  if (!open) return null

  // The group of the previous row, used to decide where a heading goes.
  function groupOf(prev: Item | undefined): string | undefined {
    return prev && prev.kind === 'action' ? prev.group : undefined
  }

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-start justify-center pt-[12vh] bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-border bg-card shadow-2xl animate-pop-in overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground/50 shrink-0">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search threads or type a command..."
            className="h-10 flex-1 bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground/40 outline-none"
          />
          <kbd className="shrink-0 rounded border border-border/60 bg-secondary px-1.5 py-px font-mono text-[10px] text-muted-foreground/60">
            ESC
          </kbd>
        </div>

        <div className="max-h-80 overflow-y-auto p-1.5">
          {items.length === 0 && (
            <div className="px-3 py-6 text-center text-[12px] text-muted-foreground/60">
              No results
            </div>
          )}

          {items.map((item, i) => (
            <div key={item.kind === 'thread' ? 't:' + item.id : 'a:' + item.id}>
            {/* Section heading whenever the group changes — so View / Thread /
                Appearance read as distinct blocks instead of one long list. */}
            {item.kind === 'action' && item.group && item.group !== groupOf(items[i - 1]) && (
              <div className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/50">
                {item.group}
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                if (item.kind === 'thread') { onSwitch(item.id); onClose() }
                if (item.kind === 'action') item.run()
              }}
              onMouseEnter={() => setActiveIdx(i)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[12.5px] transition-colors',
                activeIdx === i ? 'bg-accent text-foreground' : 'text-muted-foreground',
              )}
            >
              {item.kind === 'thread' ? (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-muted-foreground/50">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-foreground">{item.title}</div>
                    <div className="truncate text-[11px] text-muted-foreground/60">{item.subtitle}</div>
                  </div>
                </>
              ) : (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-muted-foreground/50">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                  <span className="flex-1 truncate">{item.label}</span>
                  {item.hint && (
                    <kbd className="shrink-0 rounded border border-border/60 bg-secondary px-1.5 py-px font-mono text-[10px] text-muted-foreground/60">
                      {item.hint}
                    </kbd>
                  )}
                </>
              )}
            </button>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground/50">
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border/60 bg-secondary px-1 font-mono text-[9px]">↑↓</kbd> Navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border/60 bg-secondary px-1 font-mono text-[9px]">↵</kbd> Open
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border/60 bg-secondary px-1 font-mono text-[9px]">Esc</kbd> Close
          </span>
        </div>
      </div>
    </div>
  )
}
