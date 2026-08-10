// Parser for the Parallax agent protocol emitted by the model.
//
// Delimiters: the canonical form is BRACES { } — {plx:run}…{/plx:run}. Braces
// aren't special in Markdown or HTML, so a bare tag survives a DOM scrape intact
// (ChatGPT's renderer parses <plx:run> into an element and the delimiters vanish),
// and the model reproduces braces far more reliably than the old guillemets ‹ ›.
// For tolerance the parser still accepts < >, the guillemets, and their common
// look-alikes on both ends (see OPEN/CLOSE), so pre-switch threads keep working.
//
// Self-contained (no imports) so it can be unit-tested in isolation.

export type AgentAction =
  | { type: 'note'; text: string }
  | { type: 'read'; path: string }
  | { type: 'list'; path: string }
  | { type: 'search'; query: string; path: string | null }
  | { type: 'run'; command: string; approval?: 'required' }
  | { type: 'write'; path: string; content: string; approval?: 'required' }
  | { type: 'done'; text: string }

export interface ParseResult {
  actions: AgentAction[]
  hasDone: boolean
}

// The delimiters the model is TOLD to use are BRACES { } — chosen because the
// model reproduces them near-perfectly (unlike the old guillemets ‹ ›, which it
// substituted with look-alikes) AND because braces aren't special in Markdown or
// HTML, so a bare {plx:run} survives a DOM scrape intact (angle brackets don't —
// the browser parses <plx:run> into an element and the delimiters vanish).
//
// We still ACCEPT the legacy guillemets and their look-alikes on both ends, so
// threads mid-flight from before the switch keep working. `{` `}` are literal
// inside a regex character class — no escaping needed.
const OPEN = '{<‹⟨«〈＜〈'
const CLOSE = '}>›⟩»〉＞〉'

// Group 1 = tag, 2 = raw attrs, 3 = body (paired form only). \1 pairs the close
// tag to its opener. The close allows stray whitespace (‹ / plx:run ›) because
// the model sometimes spaces it out.
const TAG_RE = new RegExp(
  `[${OPEN}]\\s*plx:(note|read|list|search|run|write|done)\\b([^${CLOSE}]*?)` +
    `(?:\\/[${CLOSE}]|[${CLOSE}]([\\s\\S]*?)[${OPEN}]\\s*\\/\\s*plx:\\1\\s*[${CLOSE}])`,
  'g',
)

function decodeAttr(raw: string): string {
  return raw
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /(\w+)\s*=\s*"([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) attrs[m[1]] = decodeAttr(m[2])
  return attrs
}

export function parseAgentActions(text: string): ParseResult {
  const actions: AgentAction[] = []
  let hasDone = false
  let m: RegExpExecArray | null
  TAG_RE.lastIndex = 0
  while ((m = TAG_RE.exec(text))) {
    const tag = m[1]
    const attrs = parseAttrs(m[2] || '')
    const body = (m[3] ?? '').trim()
    switch (tag) {
      case 'note': {
        const noteText = attrs.text || body
        if (noteText) actions.push({ type: 'note', text: noteText })
        break
      }
      case 'read':
        if (attrs.path) actions.push({ type: 'read', path: attrs.path })
        break
      case 'list':
        actions.push({ type: 'list', path: attrs.path || '.' })
        break
      case 'search':
        if (attrs.query) actions.push({ type: 'search', query: attrs.query, path: attrs.path || null })
        break
      case 'run': {
        const command = (attrs.command || body).trim()
        if (command) {
          actions.push({
            type: 'run',
            command,
            ...(attrs.approval === 'required' ? { approval: 'required' as const } : {}),
          })
        }
        break
      }
      case 'write':
        if (attrs.path) {
          actions.push({
            type: 'write',
            path: attrs.path,
            content: m[3] ?? '',
            ...(attrs.approval === 'required' ? { approval: 'required' as const } : {}),
          })
        }
        break
      case 'done':
        hasDone = true
        actions.push({ type: 'done', text: body })
        break
    }
  }
  return { actions, hasDone }
}

export interface ToolResult {
  status: 'ok' | 'error'
  content: string
  /** For ‹plx:write›: a unified diff of the change, shown in the UI only (never
   *  fed back to the model — it just needs the short confirmation in `content`). */
  diff?: string
}

export type ToolAction = Extract<AgentAction, { type: 'read' | 'list' | 'search' | 'run' | 'write' }>

// Now that the model works through the terminal instead of dedicated read/list/
// search tools, "read-only" has to be decided from the COMMAND. Without this every
// `ls` would hit the permission gate and Auto-review couldn't even look at a file.
const READ_ONLY_BINS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'file', 'stat', 'pwd', 'tree', 'find', 'grep',
  'rg', 'ag', 'du', 'df', 'realpath', 'basename', 'dirname', 'which', 'type',
  'echo', 'date', 'printenv', 'env', 'sed', 'awk', 'sort', 'uniq', 'diff', 'nl', 'cut',
])
const READ_ONLY_GIT = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'remote', 'ls-files', 'rev-parse',
  'describe', 'blame', 'shortlog', 'tag', 'config',
])

/**
 * True only when a shell command provably cannot change anything. Deliberately
 * conservative: any shell metacharacter (pipe, redirect, chaining, substitution)
 * means we refuse to classify it as read-only, because `ls && rm -rf /` starts
 * with an allowlisted binary. Unknown ⇒ treated as mutating ⇒ gated.
 */
export function isReadOnlyCommand(command: string): boolean {
  const cmd = (command || '').trim()
  if (!cmd) return false
  if (/[;&|><`$(){}]/.test(cmd) || /\n/.test(cmd)) return false
  const parts = cmd.split(/\s+/)
  const bin = (parts[0] || '').split('/').pop() || ''
  if (bin === 'git') {
    const optionsWithValue = new Set([
      '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix',
      '--config-env',
    ])
    let index = 1
    while (index < parts.length) {
      const part = parts[index]
      if (optionsWithValue.has(part)) {
        index += 2
        continue
      }
      if (part.startsWith('-')) {
        index += 1
        continue
      }
      break
    }
    const sub = parts[index]
    return Boolean(sub) && READ_ONLY_GIT.has(sub as string)
  }
  // `find` can delete or exec; `sed -i` edits in place.
  if (bin === 'find' && /\s-(delete|exec|execdir|ok|okdir|fls|fprint)\b/.test(cmd)) return false
  if (bin === 'sed' && /\s-[a-z]*i\b/.test(cmd)) return false
  return READ_ONLY_BINS.has(bin)
}

/** Tools that mutate state or run code, and so are subject to the permission gate. */
export function isNonReadAction(a: AgentAction): boolean {
  if (a.type === 'write') return true
  if (a.type === 'run') return !isReadOnlyCommand(a.command)
  return false
}

/** Human label for a tool action. The renderer supplies the tool-kind icon. */
export function agentActionLabel(a: AgentAction): string {
  switch (a.type) {
    case 'read':
      return a.path
    case 'list':
      return a.path
    case 'search':
      return `"${a.query}"${a.path ? ` in ${a.path}` : ''}`
    case 'run':
      return a.command
    case 'write':
      return a.path
    default:
      return a.type
  }
}

function escapeAttr(s: string): string {
  return String(s ?? '').replace(/"/g, '&quot;').replace(/[\r\n]+/g, ' ')
}

/** Serialize executed tool results into the {plx:result} blocks fed back to the model. */
// ChatGPT rejects an over-long message outright ("The message you submitted was
// too long"), which kills the whole turn. The executor's per-result caps (100KB a
// command, 200KB a file) are far too generous once the model BATCHES — and we
// actively tell it to, so a turn with 16 `cat`s could compose a multi-megabyte
// message. The only cap that matters is on the composed message, so it lives here.
//
// Budgets are chars of RESULT BODY; the tag scaffolding around them is small and
// the total leaves ChatGPT ample headroom.
const MAX_RESULT_CHARS = 6000 // no single result may dominate the turn
const MAX_TOTAL_RESULT_CHARS = 24000 // whole-turn ceiling

// Max-min fair ("water-filling") split of `total` across `lengths`: every result
// that fits inside an equal share keeps ALL of its content, and the space they
// leave unused is redistributed to the big ones. So 15 short results plus one huge
// file truncate only the huge file, instead of chopping all sixteen to 1/16th.
function allocateBudgets(lengths: number[], total: number): number[] {
  const out = new Array<number>(lengths.length).fill(0)
  const order = lengths.map((len, i) => ({ len, i })).sort((a, b) => a.len - b.len)
  let remaining = total
  let left = order.length
  for (const { len, i } of order) {
    const give = Math.min(len, Math.floor(remaining / left))
    out[i] = give
    remaining -= give
    left -= 1
  }
  return out
}

// Keep the HEAD and the TAIL, elide the middle: a `cat` is most useful from the
// top, a failing command's output from the bottom. The marker states the real size
// and how to get the rest, so the model asks for a slice instead of guessing.
function truncateResult(content: string, budget: number): string {
  if (content.length <= budget) return content
  const marker =
    `\n… [truncated by Parallax — ${budget} of ${content.length} characters shown. ` +
    `Re-read just the part you need: \`sed -n '120,240p' FILE\`, \`head -n 80 FILE\`, ` +
    `\`tail -n 80 FILE\`, or \`rg -n PATTERN FILE\`.] …\n`
  const keep = budget - marker.length
  if (keep <= 0) return marker.trim()
  const headLen = Math.ceil(keep * 0.65)
  const tailLen = keep - headLen
  // Cut on line boundaries so neither side starts or ends mid-line.
  let head = content.slice(0, headLen)
  const lastNl = head.lastIndexOf('\n')
  if (lastNl > headLen * 0.5) head = head.slice(0, lastNl)
  let tail = tailLen > 0 ? content.slice(content.length - tailLen) : ''
  const firstNl = tail.indexOf('\n')
  if (firstNl !== -1 && firstNl < tailLen * 0.5) tail = tail.slice(firstNl + 1)
  return head + marker + tail
}

export function formatAgentResults(actions: AgentAction[], results: ToolResult[]): string {
  const bodies = actions.map((_, i) => (results[i]?.content ?? 'No result.') || '(no output)')
  // Cap each result first, then fair-share whatever the whole turn is allowed.
  const capped = bodies.map((c) => Math.min(c.length, MAX_RESULT_CHARS))
  const budgets = allocateBudgets(capped, MAX_TOTAL_RESULT_CHARS)
  return actions
    .map((a, i) => {
      const r = results[i] ?? { status: 'error' as const, content: 'No result.' }
      let attrs: string
      switch (a.type) {
        case 'search':
          attrs = `kind="search" query="${escapeAttr(a.query)}"${a.path ? ` path="${escapeAttr(a.path)}"` : ''}`
          break
        case 'run':
          attrs = `kind="run" command="${escapeAttr(a.command)}"`
          break
        case 'read':
        case 'list':
        case 'write':
          attrs = `kind="${a.type}" path="${escapeAttr(a.path)}"`
          break
        default:
          attrs = `kind="${a.type}"`
      }
      const body = truncateResult(bodies[i], budgets[i])
      return `{plx:result ${attrs} status="${r.status}"}\n${body}\n{/plx:result}`
    })
    .join('\n\n')
}

/** Remove parallax protocol tags (any delimiter, complete/self-closing/partial/mangled) from display text. */
export function stripAgentTags(text: string): string {
  // Same delimiter family the parser accepts (see OPEN/CLOSE) so display and parse
  // never disagree about what's a tag. `O`/`C` are the char-class bodies.
  const O = OPEN
  const C = CLOSE
  // A paired ‹plx:TAG›…‹/plx:TAG›. `tag` may be a literal ("done") or an
  // alternation whose close backreferences \1 ("(note|read|…)").
  const paired = (tag: string) =>
    new RegExp(
      `[${O}]\\s*plx:${tag}\\b[^${C}]*[${C}]([\\s\\S]*?)[${O}]\\s*\\/\\s*plx:${tag.startsWith('(') ? '\\1' : tag}\\s*[${C}]`,
      'g',
    )
  return (
    text
      // ‹plx:done›…final answer…‹/plx:done› — UNWRAP: keep the answer, drop the tag.
      .replace(paired('done'), '$1')
      // ‹plx:result›… blocks are the harness's; if echoed into the answer, drop them.
      .replace(paired('result'), '')
      .replace(paired('(note|read|list|search|run|write)'), '')
      .replace(new RegExp(`[${O}]\\s*plx:(?:note|read|list|search|run|write|done)\\b[^${C}]*\\/[${C}]`, 'g'), '')
      // STREAMING: ‹plx:done› opened but hasn't closed yet — unwrap the partial
      // answer so it renders token-by-token instead of appearing all at once.
      .replace(new RegExp(`[${O}]\\s*plx:done\\b[^${C}]*[${C}]([\\s\\S]*)$`), '$1')
      // An action opener whose closing tag never arrived is protocol, not prose.
      // Remove the entire unfinished action before the generic tag cleanup below
      // strips its opener and accidentally leaves the command body visible.
      .replace(
        new RegExp(
          `[${O}]\\s*plx:(?:note|read|list|search|run|write)\\b[^${C}]*[${C}][\\s\\S]*$`,
        ),
        '',
      )
      .replace(new RegExp(`[${O}]\\s*\\/?\\s*plx:[a-z]+[^${C}]*[${C}]`, 'g'), '')
      .replace(new RegExp(`[${O}]\\s*plx:[\\s\\S]*$`, 'g'), '')
      // A tag opener cut mid-token at the very end — "{w", "{we", "{/parallax". A `w`
      // MUST follow the (optional-slash) opener: a bare trailing "{" is left alone,
      // because braces are common in code and eating a real trailing "{" would
      // corrupt the answer. A tag genuinely cut at just "{" shows for one stream
      // frame until the next token arrives — a fine trade for never mangling code.
      .replace(new RegExp(`[${O}]\\s*\\/?\\s*w(?:e(?:s(?:s(?::[a-z]*)?)?)?)?$`, 'i'), '')
      .trim()
  )
}
