import { useEffect, useRef, useState, useCallback, useMemo, memo } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeHighlight from 'rehype-highlight'
import type { Components } from 'react-markdown'
import type { Conversation, AgentCall, Message } from '../hooks/useParallax'
import { stripAgentTags } from '../lib/agentProtocol'
import { visibleTranscriptMessages } from '../lib/transcript'
import { cn } from '../lib/utils'
import { highlightToHtml, langForPath } from '../lib/highlight'

// ChatGPT emits LaTeX with \( \) (inline) and \[ \] (display) delimiters, but
// remark-math only understands $…$ / $$…$$. Convert them so KaTeX renders the
// math instead of the raw brackets showing through. Fenced/inline code is left
// untouched so real backslash-bracket code isn't mangled.
function normalizeMath(input: string): string {
  if (!input || (input.indexOf('\\[') === -1 && input.indexOf('\\(') === -1)) return input
  // Split on ``` fences and `inline code`; only transform the segments between.
  const parts = input.split(/(```[\s\S]*?```|`[^`\n]*`)/g)
  return parts
    .map((seg, i) => {
      if (i % 2 === 1) return seg // a code segment — leave as-is
      return seg
        .replace(/\\\[([\s\S]+?)\\\]/g, (_m, body) => `$$${body}$$`)
        .replace(/\\\(([\s\S]+?)\\\)/g, (_m, body) => `$${body}$`)
    })
    .join('')
}

// Older persisted calls included the tool kind in their label. Keep that path
// fallback so those transcripts retain extension-aware highlighting.
function pathFromLabel(label?: string): string | undefined {
  if (!label) return undefined
  const m = /^(?:read|write|list|search)\s+(.+)$/.exec(label.trim())
  return m ? m[1].trim() : undefined
}

// A syntax-highlighted, read-only code view for tool-call output. The file
// extension is authoritative; unknown formats remain escaped plain text.
function HighlightedCode({ code, lang }: { code: string; lang?: string }) {
  // Driven entirely off the file extension (resolved from the path/label). No
  // auto-detect and no content-shape guessing — the extension is authoritative;
  // unknown extensions render as escaped plain text.
  const html = useMemo(() => highlightToHtml(code, lang), [code, lang])
  return (
    <pre className="parallax-code" data-tool-result data-tool-language={lang || 'plain'}>
      <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  )
}

// Renders a unified diff with per-line +/- coloring (git-style).
function DiffView({ diff }: { diff: string }) {
  // The surrounding card already names the file, so unified-diff transport
  // headers add noise (especially "/dev/null" for a newly created file).
  const lines = diff.split('\n').filter((line) => {
    if (line.startsWith('diff --git ')) return false
    if (line.startsWith('index ')) return false
    if (line.startsWith('new file mode ') || line.startsWith('deleted file mode ')) return false
    if (/^--- (?:a\/|\/dev\/null(?:\t|$))/.test(line)) return false
    if (/^\+\+\+ (?:b\/|\/dev\/null(?:\t|$))/.test(line)) return false
    return true
  })
  return (
    <pre className="parallax-diff">
      {lines.map((l, i) => {
        const cls =
          l.startsWith('+++') || l.startsWith('---')
            ? 'diff-file'
            : l.startsWith('@@')
              ? 'diff-hunk'
              : l.startsWith('+')
                ? 'diff-add'
                : l.startsWith('-')
                  ? 'diff-del'
                  : 'diff-ctx'
        return (
          <span key={i} className={cn('diff-line', cls)}>
            {l.length ? l : ' '}
          </span>
        )
      })}
    </pre>
  )
}

interface Props {
  conversation: Conversation | null
  sending?: boolean
  onEditMessage?: (messageId: string, text: string, originalText: string) => void
}

function getFileIcon(mime: string): string {
  if (mime.startsWith('image/'))
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>'
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>'
}

const MARKDOWN_COMPONENTS: Components = {
  a: ({ children, ...props }) => (
    <a {...props} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  table: ({ children, ...props }) => (
    <div className="chat-markdown-table-container">
      <table {...props}>{children}</table>
    </div>
  ),
}

const REMARK_PLUGINS = [remarkGfm, remarkBreaks, remarkMath]
const REHYPE_PLUGINS: any = [
  rehypeKatex,
  // detect: color fenced code even when the language is omitted (GPT often does);
  // ignoreMissing: don't throw on an unknown language.
  [rehypeHighlight, { detect: true, ignoreMissing: true }],
]

const StreamingText = memo(function StreamingText({ text }: { text: string }) {
  const initial = text.slice(0, Math.min(1, text.length))
  const [visibleText, setVisibleText] = useState(initial)
  const visibleRef = useRef(initial)

  useEffect(() => {
    let start = visibleRef.current
    if (!text.startsWith(start)) {
      start = text.slice(0, Math.min(1, text.length))
      visibleRef.current = start
      setVisibleText(start)
    }
    const remaining = text.length - start.length
    if (remaining <= 0) return

    // Network snapshots arrive in uneven chunks. Reveal each new chunk over at
    // most five short ticks so a three-character answer still visibly streams,
    // while a long snapshot never trails the network by more than 120ms. Timers
    // are intentional: animation frames can stop in an occluded Electron window.
    const steps = Math.min(5, remaining)
    let step = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const advance = () => {
      step += 1
      const length = start.length + Math.ceil((remaining * step) / steps)
      const next = text.slice(0, length)
      visibleRef.current = next
      setVisibleText(next)
      if (step < steps) timer = setTimeout(advance, 24)
    }
    timer = setTimeout(advance, 24)
    return () => {
      if (timer) clearTimeout(timer)
    }
  }, [text])

  return (
    <div data-streaming-copy>
      <Markdown text={visibleText} />
    </div>
  )
})

const Markdown = memo(function Markdown({ text }: { text: string }) {
  const normalized = useMemo(() => normalizeMath(text), [text])
  return (
    <div className="chat-markdown parallax-transcript-copy">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={MARKDOWN_COMPONENTS}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  )
})

function CopyButton({
  text,
  title = 'Copy message',
  className,
}: {
  text: string
  title?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const handleCopy = useCallback(() => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }, [text])
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        handleCopy()
      }}
      onKeyDown={(event) => event.stopPropagation()}
      className={cn(
        'inline-flex size-6 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground',
        className,
      )}
      aria-label={title}
      title={title}
    >
      {copied ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      )}
    </button>
  )
}

function EditButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
      aria-label="Edit message"
      title="Edit message"
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
      </svg>
    </button>
  )
}

function ToolCallsCard({ toolCalls }: { toolCalls: string }) {
  const lines = toolCalls.split('\n').filter((l) => l.trim().length > 0)
  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-border">
      <div className="border-b border-border/65 bg-muted/20 px-3.5 py-2 text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground/70">
        Tool calls{lines.length > 0 ? ` (${lines.length})` : ''}
      </div>
      <div className="flex flex-col gap-1 px-3.5 py-2.5">
        {lines.length > 0 ? (
          lines.map((line, i) => (
            <div key={i} className="flex items-start gap-2 text-[11.5px] leading-relaxed text-muted-foreground">
              <span className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/40" />
              <span className="min-w-0 whitespace-pre-wrap break-words font-mono">{line}</span>
            </div>
          ))
        ) : (
          <span className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-muted-foreground">
            {toolCalls}
          </span>
        )}
      </div>
    </div>
  )
}

function AgentNote({ text }: { text: string }) {
  return (
    <div className="parallax-agent-note text-foreground" data-agent-note>
      <Markdown text={text} />
    </div>
  )
}

const TOOL_KIND_TITLES: Record<AgentCall['kind'], string> = {
  read: 'File read',
  list: 'Directory listing',
  search: 'Search',
  run: 'Shell command',
  write: 'File write',
}
const SOURCE_OUTPUT_BINS = new Set(['cat', 'head', 'tail', 'sed', 'nl'])

function visibleToolLabel(call: AgentCall): string {
  const prefix = `${call.kind} `
  return call.label.toLowerCase().startsWith(prefix)
    ? call.label.slice(prefix.length).trim()
    : call.label
}

// Shell reads are highlighted only when one simple command prints one source
// file. Pipelines and command chains stay terminal text because their output may
// combine unrelated formats.
function sourcePathFromShellCommand(command: string): string | undefined {
  if (!command || /[|;&]/.test(command)) return undefined
  const tokens = command.trim().split(/\s+/)
  const bin = (tokens[0] || '').split('/').pop()
  if (!bin || !SOURCE_OUTPUT_BINS.has(bin)) return undefined
  for (let index = tokens.length - 1; index > 0; index--) {
    const candidate = tokens[index].replace(/^['"]|['"]$/g, '')
    if (!candidate.startsWith('-') && langForPath(candidate)) return candidate
  }
  return undefined
}

function sourceBodyFromTerminalResult(result: string): string {
  const lines = result.trimEnd().split('\n')
  if (lines[0]?.startsWith('$ ')) lines.shift()
  if (/^\[exit (?:\d+|signal .+)\]$/.test(lines[lines.length - 1] || '')) lines.pop()
  return lines.join('\n')
}

// The tool's identity icon (left of the row): eye = read, list = list,
// magnifier = search, terminal = run, square-pen = write.
function ToolKindIcon({ kind }: { kind: AgentCall['kind'] }) {
  const p = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, className: 'block size-3.5 shrink-0', 'aria-hidden': true }
  switch (kind) {
    case 'read':
      return (<svg {...p}><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>)
    case 'list':
      return (<svg {...p}><path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /><path d="M3 6h.01" /><path d="M3 12h.01" /><path d="M3 18h.01" /></svg>)
    case 'search':
      return (<svg {...p}><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>)
    case 'run':
      return (<svg {...p}><path d="m4 17 6-6-6-6" /><path d="M12 19h8" /></svg>)
    case 'write':
      return (<svg {...p}><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.4 2.6a1 1 0 0 1 3 3l-9 9-3.9 1 1-3.9z" /></svg>)
  }
}

// A slim, single-line tool-call row — t3code's flow: identity icon, label, an
// optional diff stat, a rotating chevron, and a right-aligned status indicator.
// The whole row is the toggle; the body slides open with a height animation.
function ToolCallRow({ call }: { call: AgentCall }) {
  const hasDiff = call.kind === 'write' && Boolean(call.diff)
  const displayLabel = visibleToolLabel(call)
  const sourcePath =
    call.kind === 'read'
      ? call.path || pathFromLabel(call.label)
      : call.kind === 'run'
        ? sourcePathFromShellCommand(displayLabel)
        : undefined
  const sourceLanguage = langForPath(sourcePath)
  // Keep every detail row stable and collapsed until the user opens it. A write
  // result used to expand itself as soon as its diff arrived, shifting the entire
  // transcript underneath the pointer.
  const [open, setOpen] = useState(false)
  const expandable = Boolean(call.result || call.diff)
  const terminalCopyText = useMemo(() => {
    if (call.kind !== 'run' || !call.result) return null
    const result = call.result.trimEnd()
    if (/^\$ /.test(result)) return result
    return `$ ${displayLabel}\n${result}`
  }, [call.kind, call.result, displayLabel])
  const toggle = () => {
    if (!expandable) return
    setOpen((value) => !value)
  }
  return (
    <div className="group/tool parallax-transcript-enter flex flex-col rounded-md">
      <div
        className={cn(
          'rounded-md transition-colors',
          expandable
            ? 'parallax-activity-interactive cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60'
            : 'cursor-default',
        )}
        {...(expandable
          ? {
              role: 'button' as const,
              tabIndex: 0,
              'aria-expanded': open,
              'aria-label': `${TOOL_KIND_TITLES[call.kind]}: ${displayLabel}`,
              onClick: toggle,
              onKeyDown: (e: ReactKeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  toggle()
                }
              },
            }
          : {})}
      >
        <div
          className="parallax-activity-row flex w-full select-none items-center gap-1.5 rounded-md px-0.5"
          data-activity-row="tool"
          data-tool-kind={call.kind}
        >
          <span
            className="parallax-activity-secondary flex size-5 shrink-0 items-center justify-center"
            data-activity-icon
            title={TOOL_KIND_TITLES[call.kind]}
          >
            <ToolKindIcon kind={call.kind} />
          </span>
          <span
            className="parallax-activity-command min-w-0 flex-1 truncate font-mono"
            title={displayLabel}
          >
            {displayLabel}
          </span>
          {hasDiff && <DiffStat diff={call.diff!} />}
          <span
            className="parallax-activity-tertiary flex size-4 shrink-0 items-center justify-center"
            data-activity-disclosure
          >
            {expandable && (
              <svg
                width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
                className={cn('size-3 shrink-0 transition-transform duration-100', open && 'rotate-180')}
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            )}
          </span>
          <span className="flex size-4 shrink-0 items-center justify-center">
            <ToolStatusDot status={call.status} />
          </span>
        </div>
      </div>
      <div
        className={open ? 'relative block' : 'hidden'}
        data-tool-disclosure
        aria-hidden={!open}
      >
        {expandable && (
          <div
            className="parallax-activity-rule parallax-tool-result-surface mt-1 ms-[28px] cursor-default border-s ps-3"
            data-activity-rule
            onClick={(e) => e.stopPropagation()}
          >
            {hasDiff ? (
              <DiffView diff={call.diff!} />
            ) : call.result ? (
              call.kind === 'read' || (call.kind === 'run' && sourceLanguage) ? (
                <HighlightedCode
                  code={
                    call.kind === 'run'
                      ? sourceBodyFromTerminalResult(call.result)
                      : call.result
                  }
                  lang={sourceLanguage}
                />
              ) : (
                <pre
                  className="parallax-tool-output max-h-72 cursor-text overflow-auto py-1 pe-8 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words select-text"
                  data-tool-result
                >
                  {call.result}
                </pre>
              )
            ) : null}
          </div>
        )}
        {terminalCopyText && (
          <CopyButton
            text={terminalCopyText}
            title="Copy command and output"
            className="absolute end-0.5 top-1 opacity-0 group-hover/tool:opacity-100 group-focus-within/tool:opacity-100"
          />
        )}
      </div>
    </div>
  )
}

// A green/red +N −M summary of a diff, shown on the collapsed write card.
function DiffStat({ diff }: { diff: string }) {
  const { added, removed } = useMemo(() => {
    let added = 0, removed = 0
    for (const l of diff.split('\n')) {
      if (l.startsWith('+') && !l.startsWith('+++')) added++
      else if (l.startsWith('-') && !l.startsWith('---')) removed++
    }
    return { added, removed }
  }, [diff])
  if (!added && !removed) return null
  return (
    <span className="shrink-0 font-mono text-[10.5px] tabular-nums">
      {added > 0 && <span className="text-success">+{added}</span>}
      {added > 0 && removed > 0 && <span className="text-muted-foreground/40"> </span>}
      {removed > 0 && <span className="text-destructive">−{removed}</span>}
    </span>
  )
}

// The right-aligned run status: spinner while running, clock while awaiting
// approval, red ✕ on error/denial, muted slash when blocked, green ✓ on success.
function ToolStatusDot({ status }: { status: AgentCall['status'] }) {
  if (status === 'running') {
    return (
      <span
        className="parallax-tool-status-running inline-block size-3 shrink-0 animate-spin rounded-full border-2"
        data-tool-status="running"
      />
    )
  }
  if (status === 'awaiting') {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="parallax-tool-status-awaiting block size-3.5 shrink-0" data-tool-status="awaiting">
        <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
      </svg>
    )
  }
  if (status === 'error' || status === 'denied') {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className="parallax-tool-status-error block size-3 shrink-0" data-tool-status={status}>
        <path d="M18 6 6 18M6 6l12 12" />
      </svg>
    )
  }
  if (status === 'blocked') {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="parallax-activity-tertiary block size-3.5 shrink-0" data-tool-status="blocked">
        <circle cx="12" cy="12" r="9" /><path d="m5.6 5.6 12.8 12.8" />
      </svg>
    )
  }
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className="parallax-tool-status-ok block size-3 shrink-0" data-tool-status="ok">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

// ── Ordered activity transcript ─────────────────────────────────────────────
// Consecutive action turns belong to one compact activity stream. Notes remain
// visible commentary, and the calls they introduce stay nested beneath a label.
type WorkItem = { kind: 'note'; text: string } | { kind: 'call'; call: AgentCall }

interface ActivityPhase {
  key: string
  label: string
  notes: string[]
  calls: AgentCall[]
}

type TimelineRow =
  | { kind: 'message'; msg: Message; key: string }
  | { kind: 'activity'; phases: ActivityPhase[]; key: string }
  | { kind: 'turn-fold'; phases: ActivityPhase[]; key: string; label: string }

// A turn that is purely tool calls — no prose for the user to read.
function isToolOnlyTurn(m: Message): boolean {
  return m.role === 'assistant' && (m.calls?.length ?? 0) > 0 && !stripAgentTags(m.text || '').trim()
}

// One turn's notes and calls, in the order the model actually emitted them.
//
// `steps` carries that order. Without it we listed every note and THEN every call,
// so on a 45-call turn all the narration piled up at the top, detached from the
// calls it described. Messages persisted before `steps` existed have none, so they
// fall back to the old layout rather than losing their notes.
function turnItems(m: Message): WorkItem[] {
  const calls = m.calls || []
  const notes = m.notes || []
  if (m.steps?.length) {
    const items: WorkItem[] = []
    const placed = new Set<number>()
    for (const s of m.steps) {
      if (s.kind === 'note') {
        items.push({ kind: 'note', text: s.text })
      } else if (calls[s.index]) {
        items.push({ kind: 'call', call: calls[s.index] })
        placed.add(s.index)
      }
    }
    // Never drop a call because `steps` was stale or short — append any it missed.
    calls.forEach((c, idx) => {
      if (!placed.has(idx)) items.push({ kind: 'call', call: c })
    })
    return items
  }
  return [
    ...notes.map((text) => ({ kind: 'note' as const, text })),
    ...calls.map((call) => ({ kind: 'call' as const, call })),
  ]
}

interface WorkSection {
  notes: string[]
  calls: AgentCall[]
}

// A note owns the calls that follow it, up to the next note. This is the same
// ordering the model emitted and makes the association visible in the transcript.
function splitWorkSections(items: WorkItem[]): WorkSection[] {
  const sections: WorkSection[] = []
  let current: WorkSection = { notes: [], calls: [] }
  const flush = () => {
    if (current.notes.length || current.calls.length) sections.push(current)
    current = { notes: [], calls: [] }
  }
  for (const item of items) {
    if (item.kind === 'note') {
      if (current.calls.length) flush()
      if (item.text.trim()) current.notes.push(item.text.trim())
    } else {
      current.calls.push(item.call)
    }
  }
  flush()
  return sections
}

function fallbackPhaseTitle(calls: AgentCall[]): string {
  const labels = calls.map((call) => `${call.kind} ${call.label}`.toLowerCase()).join('\n')
  if (calls.some((call) => call.kind === 'write')) return 'Updating project files'
  if (/\b(?:pnpm|yarn|bun|pytest|vitest|playwright|cargo|go)\s+(?:run\s+)?test\b|\btest(?:s|ing)?\b/.test(labels)) {
    return 'Running verification'
  }
  if (/\bgit\s+(?:status|diff|log|show|branch)\b/.test(labels)) return 'Reviewing repository state'
  if (calls.some((call) => call.kind === 'search') || /\b(?:rg|grep|ag)\b/.test(labels)) {
    return 'Searching the codebase'
  }
  if (/\b(?:ls|find|tree|pwd)\b/.test(labels)) return 'Reading the repository structure'
  if (calls.some((call) => call.kind === 'read' || call.kind === 'list')) return 'Reading project files'
  return 'Working through the task'
}

function callFingerprint(call: AgentCall): string {
  return JSON.stringify([
    call.kind,
    call.label,
    call.status,
    call.result ?? '',
    call.diff ?? '',
  ])
}

function appendUniqueCalls(target: AgentCall[], calls: AgentCall[]) {
  const known = new Set(target.map(callFingerprint))
  for (const call of calls) {
    const fingerprint = callFingerprint(call)
    if (known.has(fingerprint)) continue
    known.add(fingerprint)
    target.push(call)
  }
}

function appendUniqueNotes(target: string[], notes: string[]) {
  const known = new Set(target)
  for (const note of notes) {
    if (known.has(note)) continue
    known.add(note)
    target.push(note)
  }
}

function continuesExistingPhase(current: ActivityPhase, next: ActivityPhase): boolean {
  if (current.label !== next.label) return false
  if (!next.notes.length) return true
  return next.notes.every((note) => current.notes.includes(note))
}

function phasesForTurn(m: Message, rowKey: string): ActivityPhase[] {
  return splitWorkSections(turnItems(m)).flatMap((section, index) => {
    if (!section.calls.length) return []
    return [{
      key: `${rowKey}-phase-${index}`,
      label: fallbackPhaseTitle(section.calls),
      notes: [...section.notes],
      calls: [...section.calls],
    }]
  })
}

function isIncompleteProtocolTurn(m: Message): boolean {
  const raw = m.text || ''
  return (
    m.role === 'assistant' &&
    Boolean(raw.trim()) &&
    !stripAgentTags(raw).trim() &&
    !(m.calls?.length) &&
    !(m.notes?.length) &&
    !m.toolCalls
  )
}

function hasAssistantProgress(message: Message): boolean {
  return (
    message.role === 'assistant' &&
    Boolean(
      stripAgentTags(message.text || '').trim() ||
      message.toolCalls ||
      message.notes?.length ||
      message.calls?.length,
    )
  )
}

function messageStartedAt(message: Message): number | null {
  if (!message.msgId) return null
  const timestamp = Number(message.msgId.split('-', 1)[0])
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null
}

function completedWorkLabel(startedAt: number | null, completedAt?: number): string {
  if (!startedAt || !completedAt || completedAt < startedAt) return 'Worked'
  return `Worked for ${formatElapsed(Math.floor((completedAt - startedAt) / 1000))}`
}

function buildTimelineRows(messages: Message[]): TimelineRow[] {
  const rows: TimelineRow[] = []
  const visibleMessages = visibleTranscriptMessages(messages)
  let turnStartedAt: number | null = null
  for (let i = 0; i < visibleMessages.length; i++) {
    const m = visibleMessages[i]
    const originalIndex = messages.indexOf(m)
    const messageKey = m.msgId || `legacy:${originalIndex}`
    if (m.role === 'user') turnStartedAt = messageStartedAt(m)
    if (isToolOnlyTurn(m)) {
      const phases = phasesForTurn(m, messageKey)
      const previous = rows[rows.length - 1]
      if (previous?.kind === 'activity') {
        for (const phase of phases) {
          const lastPhase = previous.phases[previous.phases.length - 1]
          if (lastPhase && continuesExistingPhase(lastPhase, phase)) {
            appendUniqueNotes(lastPhase.notes, phase.notes)
            appendUniqueCalls(lastPhase.calls, phase.calls)
          } else previous.phases.push(phase)
        }
      } else {
        rows.push({ kind: 'activity', phases, key: `activity-${messageKey}` })
      }
      continue
    }
    // A recovered half-tag between completed action turns is transport debris,
    // not a separate response. Keep a trailing one visible as an interruption.
    if (isIncompleteProtocolTurn(m) && i < visibleMessages.length - 1) continue
    const previous = rows[rows.length - 1]
    if (
      m.role === 'assistant' &&
      !m.streaming &&
      previous?.kind === 'activity'
    ) {
      rows[rows.length - 1] = {
        kind: 'turn-fold',
        phases: previous.phases,
        key: `turn-fold-${previous.key}`,
        label: completedWorkLabel(turnStartedAt, m.completedAt),
      }
    }
    rows.push({ kind: 'message', msg: m, key: messageKey })
  }
  return rows
}

function sectionStatus(calls: AgentCall[]): AgentCall['status'] {
  if (calls.some((call) => call.status === 'running')) return 'running'
  if (calls.some((call) => call.status === 'awaiting')) return 'awaiting'
  if (calls.some((call) => call.status === 'error')) return 'error'
  if (calls.some((call) => call.status === 'denied')) return 'denied'
  if (calls.some((call) => call.status === 'blocked')) return 'blocked'
  return 'ok'
}

function ActivityPhaseView({ phase, active }: { phase: ActivityPhase; active: boolean }) {
  const { label, notes, calls } = phase
  const [expanded, setExpanded] = useState(false)
  return (
    <section
      className="parallax-phase-enter flex w-full flex-col"
      aria-label={label}
      data-activity-phase
      data-active={active ? 'true' : 'false'}
    >
      {notes.length > 0 && (
        <div className="flex flex-col gap-2 pb-1.5" data-activity-commentary>
          {notes.map((note, index) => (
            <AgentNote key={`${phase.key}-note-${index}`} text={note} />
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="parallax-phase-trigger group/phase parallax-activity-row flex w-full cursor-pointer items-center gap-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60"
        data-activity-row="phase"
      >
        <span className={cn(
          'parallax-phase-title min-w-0 truncate',
          active && 'parallax-shimmer',
        )}>
          {label}
        </span>
        <span
          className="parallax-activity-secondary flex size-3.5 shrink-0 items-center justify-start opacity-0 transition-opacity duration-150 group-hover/phase:opacity-100"
          data-activity-icon
        >
          <svg
            width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
            className={cn('size-3.5 shrink-0 transition-transform duration-200', expanded && 'rotate-90')}
            aria-hidden
          >
            <path d="M9 18l6-6-6-6" />
          </svg>
        </span>
        <span className="min-w-0 flex-1" aria-hidden />
        <span className="flex size-4 shrink-0 items-center justify-center">
          <ToolStatusDot status={active ? 'running' : sectionStatus(calls)} />
        </span>
      </button>
      {expanded && (
        <div className="parallax-activity-rule ms-2 border-s ps-2" data-activity-rule>
          {calls.map((call, index) => (
            <ToolCallRow key={`${phase.key}-call-${index}`} call={call} />
          ))}
        </div>
      )}
    </section>
  )
}

function ActivityGroup({
  phases,
  active,
}: {
  phases: ActivityPhase[]
  active: boolean
}) {
  return (
    <div className="relative w-full min-w-0 px-1 py-0.5">
      <div className="flex flex-col gap-0.5">
        {phases.map((phase, index) => (
          <ActivityPhaseView
            key={phase.key}
            phase={phase}
            active={active && index === phases.length - 1}
          />
        ))}
      </div>
    </div>
  )
}

function TurnFold({
  phases,
  label,
}: {
  phases: ActivityPhase[]
  label: string
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="border-b border-border/60 pb-2 pt-1" data-turn-fold>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="parallax-turn-fold-label flex cursor-pointer select-none items-center gap-1 rounded-md px-1 tabular-nums transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      >
        <span>{label}</span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={cn('size-3.5 transition-transform duration-150', expanded && 'rotate-90')}
          aria-hidden
        >
          <path d="M9 18l6-6-6-6" />
        </svg>
      </button>
      {expanded && (
        <div className="pt-1.5">
          <ActivityGroup phases={phases} active={false} />
        </div>
      )}
    </div>
  )
}

function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}m ${s.toString().padStart(2, '0')}s`
}

// "Working for Xs" — pulsing dots plus a live elapsed timer. The timer writes its
// own text node on an interval so the streaming turn doesn't re-render each second.
function ThinkingTag() {
  const startRef = useRef(Date.now())
  const textRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const tick = () => {
      if (!textRef.current) return
      const sec = Math.floor((Date.now() - startRef.current) / 1000)
      textRef.current.textContent = sec >= 1 ? formatElapsed(sec) : ''
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])
  return (
    <div className="parallax-thinking-enter mb-4 w-full shrink-0 px-1 py-0.5" aria-label="Thinking">
      <div
        className="parallax-thinking-row parallax-activity-row flex w-full items-center gap-1.5 overflow-hidden rounded-md"
        data-activity-row="thinking"
      >
        <span className="parallax-thinking-label parallax-thinking-pulse flex min-w-0 flex-1 items-center truncate">
          <span className="parallax-shimmer">Thinking</span>
        </span>
        <span
          ref={textRef}
          className="parallax-activity-tertiary flex h-6 w-[4.25rem] shrink-0 items-center justify-end tabular-nums"
        />
        <span className="flex size-4 shrink-0 items-center justify-center">
          <ToolStatusDot status="running" />
        </span>
      </div>
    </div>
  )
}

export default function MessageLog({ conversation, sending, onEditMessage }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  // The inner content column — what a ResizeObserver has to watch, since the
  // scroll container itself never changes size.
  const contentRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewName, setPreviewName] = useState<string>('')
  const [previewMime, setPreviewMime] = useState<string>('')
  const [editingMessage, setEditingMessage] = useState<{
    key: string
    messageId: string
    original: string
    draft: string
  } | null>(null)
  // Only auto-follow the stream when the user is already at the bottom; if they've
  // scrolled up to read, DON'T yank them back down on each update.
  const nearBottomRef = useRef(true)
  const prevConvId = useRef<string | null>(null)

  useEffect(() => {
    setEditingMessage(null)
  }, [conversation?.id])

  // ONE threshold for both "keep following" and "offer the jump button". They used
  // to be 120 and 100, so anywhere in that 20px band we auto-scrolled AND showed
  // "Scroll to end" at the same time — the button flickering in unprompted.
  const AT_BOTTOM_PX = 80
  const syncScrollState = useCallback(() => {
    const el = ref.current
    const end = endRef.current
    if (!el || !end) return
    const containerBox = el.getBoundingClientRect()
    const endBox = end.getBoundingClientRect()
    // Measure the rendered end marker, not scrollHeight. A collapsed disclosure
    // is absent from this geometry, so content hidden behind a closed chevron can
    // never make the transcript look farther from its visible end.
    const atBottom =
      el.scrollHeight <= el.clientHeight + 1 ||
      endBox.top <= containerBox.bottom + AT_BOTTOM_PX
    nearBottomRef.current = atBottom
    setShowScrollButton(!atBottom)
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const switched = prevConvId.current !== (conversation?.id ?? null)
    prevConvId.current = conversation?.id ?? null
    if (switched || nearBottomRef.current) {
      el.scrollTop = el.scrollHeight
      nearBottomRef.current = true
      setShowScrollButton(false)
    } else {
      // Content grew while the user was reading further up: the distance to the
      // bottom changed with NO scroll event, so refresh the button ourselves
      // instead of leaving whatever the last scroll happened to compute.
      syncScrollState()
    }
  }, [conversation?.id, conversation?.messages, syncScrollState])

  // The container's height changes for reasons that fire NO scroll event and change
  // NO message: a tool-call group collapsing when its turn settles, you clicking a
  // chevron, markdown/KaTeX finishing, an image loading. Each one moves the bottom
  // out from under us, and without this the button just keeps whatever the last
  // scroll happened to compute — which is why "Scroll to end" sat there while you
  // were already at the end (collapsing a big group shrinks the page under you).
  // A ResizeObserver on the content catches every cause without enumerating any.
  useEffect(() => {
    const el = ref.current
    const content = contentRef.current
    if (!el || !content || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (nearBottomRef.current) {
        // Stay pinned: content grew/shrank while we were following along.
        el.scrollTop = el.scrollHeight
        setShowScrollButton(false)
      } else {
        syncScrollState()
      }
    })
    ro.observe(content)
    return () => ro.disconnect()
  }, [syncScrollState])

  // Must run before the early returns below — hooks can't be conditional.
  const rows = useMemo(
    () => buildTimelineRows(conversation?.messages ?? []),
    [conversation?.messages],
  )

  function handleScroll() {
    syncScrollState()
  }

  function scrollToBottom() {
    if (!ref.current) return
    ref.current.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' })
  }

  if (!conversation) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <div className="text-xl font-medium text-foreground">Pick a thread to continue</div>
        <p className="max-w-sm text-sm text-muted-foreground/78">
          Select an existing thread or create a new one to get started.
        </p>
      </div>
    )
  }

  if (conversation.messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <p className="text-sm text-muted-foreground/30">Send a message to start the conversation.</p>
      </div>
    )
  }

  // "Thinking" owns exactly one state: after the latest user message and before
  // the first visible assistant progress. Once a phase or answer appears it never
  // comes back during later action rounds or partial protocol frames.
  const transcript = visibleTranscriptMessages(conversation.messages)
  let lastUserIndex = -1
  for (let index = transcript.length - 1; index >= 0; index--) {
    if (transcript[index].role === 'user') {
      lastUserIndex = index
      break
    }
  }
  const awaitingFirstProgress =
    lastUserIndex >= 0 &&
    !transcript.slice(lastUserIndex + 1).some(hasAssistantProgress)

  return (
    <div
      ref={ref}
      onScroll={handleScroll}
      onClickCapture={() => {
        // Disclosure state lives inside child components, so it does not change
        // this component's message props. Re-measure after the click commits the
        // open/closed layout instead of waiting for a potentially coalesced
        // ResizeObserver callback.
        setTimeout(syncScrollState, 0)
      }}
      // Marks the transcript as THE selectable region, so ⌘A selects the
      // conversation rather than the whole window (see pages/index.tsx).
      data-parallax-transcript
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div ref={contentRef} className="mx-auto flex w-full min-w-0 max-w-3xl flex-col px-4 pb-6 pt-4 sm:px-6">
        <div className="h-2 sm:h-3" />
        {rows.map((row, i) => {
          if (row.kind === 'activity') {
            const active = Boolean(sending && i === rows.length - 1)
            return (
              <div
                key={row.key}
                data-activity-stream
                className="parallax-transcript-enter group/message mb-2.5 flex max-w-full flex-col items-start gap-1 break-words"
              >
                <ActivityGroup
                  phases={row.phases}
                  active={active}
                />
              </div>
            )
          }
          if (row.kind === 'turn-fold') {
            return (
              <div key={row.key} className="parallax-transcript-enter mb-2.5 w-full px-1">
                <TurnFold phases={row.phases} label={row.label} />
              </div>
            )
          }
          const m = row.msg
          const isUser = m.role === 'user'
          const editing = isUser && editingMessage?.key === row.key
          return (
            <div
              key={row.key}
              className={cn(
                'parallax-transcript-enter group/message flex max-w-full flex-col gap-1 break-words',
                'mb-4',
                editing ? 'items-stretch' : isUser ? 'items-end' : 'items-start',
              )}
            >
              {m.attachments && m.attachments.length > 0 && (
                <div className={cn('flex flex-wrap gap-1.5', isUser ? 'max-w-[80%] justify-end' : '')}>
                  {m.attachments.map((a, j) => (
                    <button
                      key={j}
                      type="button"
                      onClick={() => {
                        setPreviewUrl(a.data || '')
                        setPreviewName(a.name)
                        setPreviewMime(a.mime)
                      }}
                      className="flex max-w-60 cursor-pointer items-center gap-1.5 rounded-lg border border-border/80 bg-background/70 px-2 py-1 text-[11px] leading-none text-muted-foreground transition-colors hover:bg-accent"
                    >
                      <span
                        className="text-muted-foreground/80"
                        dangerouslySetInnerHTML={{ __html: getFileIcon(a.mime) }}
                      />
                      <span className="max-w-[200px] truncate">{a.name}</span>
                    </button>
                  ))}
                </div>
              )}

              {m.text && isUser && (
                <div
                  className={cn(
                    'flex flex-col items-end gap-1',
                    editing ? 'w-full max-w-none' : 'max-w-[80%]',
                  )}
                  data-delivery={m.delivery || 'sent'}
                >
                  {editing && editingMessage ? (
                    <div
                      className="parallax-message-editor w-full rounded-[14px] border p-1.5"
                      data-message-editor
                    >
                      <textarea
                        autoFocus
                        value={editingMessage.draft}
                        onChange={(event) =>
                          setEditingMessage((current) =>
                            current ? { ...current, draft: event.target.value } : current,
                          )
                        }
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') {
                            event.preventDefault()
                            setEditingMessage(null)
                            return
                          }
                          if (
                            event.key === 'Enter' &&
                            (event.metaKey || event.ctrlKey) &&
                            onEditMessage &&
                            editingMessage.draft.trim() &&
                            editingMessage.draft.trim() !== editingMessage.original
                          ) {
                            event.preventDefault()
                            onEditMessage(
                              editingMessage.messageId,
                              editingMessage.draft.trim(),
                              editingMessage.original,
                            )
                            setEditingMessage(null)
                          }
                        }}
                        rows={Math.max(2, Math.min(8, editingMessage.draft.split('\n').length))}
                        className="max-h-48 min-h-16 w-full resize-none bg-transparent px-2 py-1.5 text-[14px] leading-6 text-foreground outline-none"
                        aria-label="Edit message text"
                      />
                      <div className="flex items-center justify-end gap-2 px-0.5 pb-0.5">
                        <button
                          type="button"
                          onClick={() => setEditingMessage(null)}
                          className="h-7 rounded-lg px-2.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          disabled={
                            !onEditMessage ||
                            !editingMessage.draft.trim() ||
                            editingMessage.draft.trim() === editingMessage.original
                          }
                          onClick={() => {
                            if (!onEditMessage) return
                            onEditMessage(
                              editingMessage.messageId,
                              editingMessage.draft.trim(),
                              editingMessage.original,
                            )
                            setEditingMessage(null)
                          }}
                          className="h-7 rounded-lg bg-primary px-3 text-[12px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-35"
                          title={!onEditMessage ? 'Message updates are not connected yet' : undefined}
                        >
                          Send
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div
                      // No border: the tinted fill alone separates the bubble from
                      // the transcript. The outline read as a second, competing edge
                      // against the rounded fill.
                      className="relative rounded-xl bg-secondary/80 px-2.5 py-1.5"
                      data-user-message
                    >
                      <Markdown text={m.text} />
                    </div>
                  )}
                  {m.delivery === 'failed' && (
                    <div className="pe-0.5 text-[11px] text-destructive">Not sent</div>
                  )}
                  {m.delivery === 'queued' && (
                    <div className="pe-0.5 text-[11px] text-muted-foreground/65">Queued</div>
                  )}
                  <div
                    className={cn(
                      'flex w-full items-center justify-end gap-0.5 pe-0.5 transition-opacity duration-200',
                      editing
                        ? 'pointer-events-none opacity-0'
                        : 'opacity-0 group-hover/message:opacity-100 group-focus-within/message:opacity-100',
                    )}
                  >
                    <EditButton
                      onClick={() =>
                        setEditingMessage({
                          key: row.key,
                          messageId: m.msgId || row.key,
                          original: m.text,
                          draft: m.text,
                        })
                      }
                    />
                    <CopyButton text={m.text} />
                  </div>
                </div>
              )}

              {!isUser && (() => {
                const raw = m.text || ''
                const displayText = stripAgentTags(raw)
                const hasContent = displayText || m.toolCalls || m.notes?.length || m.calls?.length
                // Protocol-only streams stay invisible until they become structured
                // work cards. If a finished response is still incomplete, show a
                // stable user-facing interruption message rather than leaking raw
                // tags or a parser diagnostic into the transcript.
                if (!hasContent) {
                  if (!raw.trim() || m.streaming) return null
                  return (
                    <div className="relative w-full min-w-0 px-1 py-0.5">
                      <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-[12.5px] leading-relaxed text-muted-foreground">
                        The response ended before its next action was complete. Send the request again to continue.
                      </div>
                    </div>
                  )
                }
                return (
                  <div className="relative w-full min-w-0 px-1 py-0.5">
                    {m.notes?.map((n, ni) => (
                      <AgentNote key={ni} text={n} />
                    ))}
                    {m.calls && m.calls.length > 0 && (
                      <section
                        className="my-1 -mx-1 flex w-[calc(100%+0.5rem)] flex-col space-y-px px-1"
                        aria-label={m.calls.length === 1 ? '1 tool call' : `${m.calls.length} tool calls`}
                      >
                        {m.calls.map((c, ci) => (
                          <ToolCallRow key={ci} call={c} />
                        ))}
                      </section>
                    )}
                    {displayText &&
                      (m.streaming ? <StreamingText text={displayText} /> : <Markdown text={displayText} />)}
                    {m.toolCalls && <ToolCallsCard toolCalls={m.toolCalls} />}
                    {displayText && (
                      <div className="mt-1.5 flex items-center gap-2 opacity-0 transition-opacity duration-200 group-hover/message:opacity-100">
                        <CopyButton text={displayText} />
                      </div>
                    )}
                  </div>
                )
              })()}
            </div>
          )
        })}

        {sending && awaitingFirstProgress && <ThinkingTag />}

        <div className="h-3 sm:h-4" />
        <div ref={endRef} data-transcript-end aria-hidden className="h-px w-full shrink-0" />
      </div>

      {showScrollButton && (
        <div className="sticky bottom-4 flex justify-center">
          <button
            type="button"
            onClick={scrollToBottom}
            className="flex items-center gap-1.5 rounded-full border border-border/60 bg-card px-3 py-1 text-[11px] text-muted-foreground shadow-sm transition-colors hover:border-border hover:text-foreground"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 9l6 6 6-6" />
            </svg>
            Scroll to end
          </button>
        </div>
      )}

      {/* File preview modal */}
      {previewName && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          onClick={() => {
            setPreviewName('')
            setPreviewUrl(null)
            setPreviewMime('')
          }}
        >
          <div
            className="relative max-h-[90vh] max-w-[90vw] overflow-auto rounded-xl border border-border bg-card shadow-2xl animate-pop-in"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => {
                setPreviewName('')
                setPreviewUrl(null)
                setPreviewMime('')
              }}
              className="absolute right-2 top-2 z-10 grid size-7 place-items-center rounded-md bg-background/80 text-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
            {previewMime.startsWith('image/') && previewUrl ? (
              <img src={previewUrl} alt={previewName} className="max-h-[85vh] max-w-[85vw] object-contain" />
            ) : previewMime === 'application/pdf' && previewUrl ? (
              <iframe src={previewUrl} title={previewName} className="h-[85vh] w-[85vw]" />
            ) : previewMime.startsWith('text/') && previewUrl ? (
              <pre className="max-h-[80vh] max-w-[80vw] overflow-auto whitespace-pre-wrap break-all p-4 font-mono text-[12px] leading-relaxed text-foreground">
                {atob(previewUrl.split(',')[1] || '') || 'Binary file'}
              </pre>
            ) : (
              <div className="flex flex-col items-center gap-3 p-8 text-muted-foreground">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                <span className="text-[13px]">{previewName}</span>
                <span className="text-[11px] text-muted-foreground/60">Preview not available for this file type</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
