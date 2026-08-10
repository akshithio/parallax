import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '../lib/utils'

interface Props {
  open: boolean
  cwd: string | null
  onClose: () => void
  /** External command to run (e.g. a topbar "action"); re-runs when nonce changes. */
  runSignal?: { cmd: string; nonce: number }
}

interface Line {
  kind: 'command' | 'output' | 'error' | 'info'
  text: string
}

// A lightweight terminal: an input + output log that runs commands in the
// thread's workspace folder via the same sandboxed `run` executor the agent uses.
export default function TerminalDrawer({ open, cwd, onClose, runSignal }: Props) {
  const [lines, setLines] = useState<Line[]>([])
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [height, setHeight] = useState(240)
  const history = useRef<string[]>([])
  const histIdx = useRef<number>(-1)
  const logRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const dragging = useRef(false)
  const lastRunNonce = useRef(0)
  // The terminal's OWN working directory. Every command is a fresh `execSync`, so
  // without this `cd` evaporated the moment it returned and you were silently back
  // at the workspace root on the next command. Starts at the thread's folder — the
  // terminal opens already cd'd into the project you're working on.
  const [termCwd, setTermCwdState] = useState<string | null>(cwd)
  // Mirrored in a ref because runCommand is an async closure: reading the state
  // directly made it see the PREVIOUS render's value, so `cd src` followed by `ls`
  // still listed the old directory — the change always landed one command late.
  const termCwdRef = useRef<string | null>(cwd)
  const setTermCwd = useCallback((v: string | null) => {
    termCwdRef.current = v
    setTermCwdState(v)
  }, [])
  useEffect(() => { setTermCwd(cwd) }, [cwd, setTermCwd])

  // Prompt label: path relative to the workspace root, so you can always see where
  // you are. Absolute (with ~) once you step outside the workspace.
  const promptPath = (() => {
    if (!termCwd) return ''
    const rootName = cwd ? cwd.split('/').filter(Boolean).pop() || cwd : ''
    if (cwd && termCwd === cwd) return rootName
    if (cwd && termCwd.startsWith(cwd + '/')) return rootName + '/' + termCwd.slice(cwd.length + 1)
    return termCwd.replace(/^\/Users\/[^/]+/, '~')
  })()

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 30)
  }, [open])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [lines])

  // Run a command pushed in from outside (a topbar "action") once per nonce.
  useEffect(() => {
    if (!runSignal || !runSignal.nonce || runSignal.nonce === lastRunNonce.current) return
    lastRunNonce.current = runSignal.nonce
    void runCommand(runSignal.cmd)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runSignal])

  async function runCommand(cmd: string) {
    const trimmed = cmd.trim()
    if (!trimmed || running) return
    // `clear`/`cls` are shell-builtins the sandboxed executor can't honor, so
    // handle them here as a local screen wipe like a real terminal.
    if (trimmed === 'clear' || trimmed === 'cls') {
      history.current.unshift(trimmed)
      histIdx.current = -1
      setInput('')
      setLines([])
      return
    }
    history.current.unshift(trimmed)
    histIdx.current = -1
    setLines((l) => [...l, { kind: 'command', text: trimmed }])
    setInput('')
    if (!cwd) {
      setLines((l) => [...l, { kind: 'error', text: 'No workspace folder set for this thread.' }])
      return
    }
    setRunning(true)
    const runDir = termCwdRef.current || cwd
    try {
      // `cd` is a shell BUILTIN — it changes the shell's own process, so running it
      // through execSync would exit immediately and change nothing. Handle it here
      // and keep the resulting directory for subsequent commands. Resolution is
      // still done BY the shell (`cd X && pwd`) so ~, .., symlinks and $VARS all
      // behave exactly as they would in a real terminal.
      const cdArg = /^cd(?:\s+(.*))?$/.exec(trimmed)
      if (cdArg) {
        const target = (cdArg[1] || '').trim() || cwd || '~'
        const res = await window.parallax?.agentExec?.({
          cwd: runDir,
          actions: [{ type: 'run', command: `cd ${target} && pwd` }],
        })
        const r = res?.results?.[0]
        const body = (r?.content || '').replace(/^\$ .*\n?/, '').replace(/\n\[exit .*\]\s*$/, '').trim()
        if (r?.status === 'ok' && body) setTermCwd(body.split('\n').pop() || runDir)
        else setLines((l) => [...l, { kind: 'error', text: body || `cd: no such directory: ${target}` }])
        return
      }
      const res = await window.parallax?.agentExec?.({ cwd: runDir, actions: [{ type: 'run', command: trimmed }] })
      const r = res?.results?.[0]
      const body = (r?.content || '').replace(/^\$ .*\n?/, '').replace(/\n\[exit .*\]\s*$/, '')
      setLines((l) => [...l, { kind: r?.status === 'error' ? 'error' : 'output', text: body || '(no output)' }])
    } catch (err: any) {
      setLines((l) => [...l, { kind: 'error', text: String(err?.message || err) }])
    } finally {
      setRunning(false)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault()
      void runCommand(input)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (histIdx.current < history.current.length - 1) {
        histIdx.current++
        setInput(history.current[histIdx.current])
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (histIdx.current > 0) {
        histIdx.current--
        setInput(history.current[histIdx.current])
      } else {
        histIdx.current = -1
        setInput('')
      }
    } else if (e.key === 'l' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      setLines([])
    }
  }

  function onDragStart(e: React.MouseEvent) {
    dragging.current = true
    const startY = e.clientY
    const startH = height
    function move(ev: MouseEvent) {
      if (!dragging.current) return
      setHeight(Math.max(120, Math.min(560, startH + (startY - ev.clientY))))
    }
    function up() {
      dragging.current = false
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }

  if (!open) return null

  return (
    <div className="flex shrink-0 flex-col border-t border-border bg-card/40" style={{ height }}>
      <div
        onMouseDown={onDragStart}
        className="h-1 shrink-0 cursor-row-resize transition-colors hover:bg-border active:bg-primary/40"
      />
      <div className="surface-subheader flex items-center justify-between gap-2 px-3">
        <div className="flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
          <TerminalIcon />
          <span>Terminal</span>
          {cwd && <span className="truncate text-muted-foreground/50">{cwd.split('/').filter(Boolean).pop()}</span>}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setLines([])}
            title="Clear (⌘L)"
            className="grid size-6 place-items-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
          </button>
          <button
            type="button"
            onClick={onClose}
            title="Close terminal"
            className="grid size-6 place-items-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
      </div>
      <div ref={logRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-[12px] leading-relaxed">
        {lines.length === 0 && (
          <div className="text-muted-foreground/40">Run a command in {cwd ? cwd.split('/').filter(Boolean).pop() : 'the workspace'}. Try `ls` or `git status`.</div>
        )}
        {lines.map((ln, i) => (
          <div
            key={i}
            className={cn(
              'whitespace-pre-wrap break-words',
              ln.kind === 'command' && 'text-foreground',
              ln.kind === 'output' && 'text-muted-foreground',
              ln.kind === 'error' && 'text-destructive',
              ln.kind === 'info' && 'text-muted-foreground/60',
            )}
          >
            {ln.kind === 'command' ? <span className="text-primary">$ </span> : null}
            {ln.text}
          </div>
        ))}
        {running && <div className="text-muted-foreground/60">…</div>}
      </div>
      <div className="flex items-center gap-2 border-t border-border/60 px-3 py-2 font-mono text-[12px]">
        {promptPath && (
          <span className="shrink-0 max-w-[45%] truncate text-muted-foreground/70" title={termCwd || ''}>
            {promptPath}
          </span>
        )}
        <span className="text-primary">$</span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          placeholder={cwd ? '' : 'set a workspace folder first'}
          className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground/40"
        />
      </div>
    </div>
  )
}

function TerminalIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m4 17 6-6-6-6M12 19h8" />
    </svg>
  )
}
