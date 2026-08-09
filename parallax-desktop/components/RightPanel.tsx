import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '../lib/utils'
import BrowserSurface from './BrowserSurface'
import { highlightLines, langForPath } from '../lib/highlight'

export type Surface = 'browser' | 'files' | 'diff'

interface Props {
  open: boolean
  cwd: string | null
  conversationId: string | null
  surface: Surface
  onSurface: (s: Surface) => void
  onClose: () => void
}

const SURFACES: { id: Surface; label: string; icon: React.ReactNode }[] = [
  { id: 'browser', label: 'Browser', icon: <GlobeIcon /> },
  { id: 'files', label: 'Files', icon: <FilesIcon /> },
  { id: 'diff', label: 'Diff', icon: <DiffIcon /> },
]

export default function RightPanel({ open, cwd, conversationId, surface, onSurface, onClose }: Props) {
  const [width, setWidth] = useState(360)
  const dragging = useRef(false)

  const onDragStart = useCallback(
    (e: React.MouseEvent) => {
      dragging.current = true
      const startX = e.clientX
      const startW = width
      function move(ev: MouseEvent) {
        if (!dragging.current) return
        setWidth(Math.max(280, Math.min(680, startW + (startX - ev.clientX))))
      }
      function up() {
        dragging.current = false
        document.removeEventListener('mousemove', move)
        document.removeEventListener('mouseup', up)
      }
      document.addEventListener('mousemove', move)
      document.addEventListener('mouseup', up)
    },
    [width],
  )

  if (!open) return null

  return (
    <div className="relative flex shrink-0 flex-col border-l border-border bg-card/30" style={{ width }}>
      <div
        onMouseDown={onDragStart}
        className="absolute left-0 top-0 z-10 h-full w-1 cursor-col-resize transition-colors hover:bg-border active:bg-primary/40"
      />
      {/* Surface tab rail */}
      <div className="surface-subheader flex items-center justify-between gap-1 pl-2 pr-1.5">
        <div className="flex items-center gap-0.5">
          {SURFACES.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onSurface(s.id)}
              title={s.label}
              className={cn(
                'flex h-7 items-center gap-1.5 rounded-md px-2 text-[11.5px] font-medium transition-colors',
                surface === s.id
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground/70 hover:bg-accent/60 hover:text-foreground',
              )}
            >
              {s.icon}
              <span>{s.label}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onClose}
          title="Close panel"
          className="grid size-6 place-items-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <div className={surface === 'browser' ? 'h-full' : 'hidden'}>
          <BrowserSurface cwd={cwd} scopeKey={conversationId} />
        </div>
        {surface === 'files' && <FilesSurface cwd={cwd} />}
        {surface === 'diff' && <DiffSurface />}
      </div>
    </div>
  )
}

function EmptySurface({ icon, title, hint }: { icon: React.ReactNode; title: string; hint: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <div className="grid size-10 place-items-center rounded-xl border border-border/70 bg-background/60 text-muted-foreground/70">
        {icon}
      </div>
      <div className="text-[13px] font-medium text-foreground">{title}</div>
      <p className="max-w-[220px] text-[12px] leading-snug text-muted-foreground/60">{hint}</p>
    </div>
  )
}

function DiffSurface() {
  return (
    <EmptySurface
      icon={<DiffIcon />}
      title="No changes yet"
      hint="When the agent writes files, the diff of this thread's changes will show up here."
    />
  )
}

type DirState =
  | { status: 'loading' }
  | { status: 'ok'; entries: string[] }
  | { status: 'error'; message: string }

type FileState =
  | { status: 'loading' }
  | { status: 'ok'; content: string }
  | { status: 'error'; message: string }

// Extensions we won't try to render as text — reading a PNG as utf8 produces
// megabytes of replacement characters that lock up the pane.
const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|pdf|zip|t?gz|bz2|xz|7z|rar|mp[34]|m4a|wav|flac|mov|avi|mkv|webm|woff2?|ttf|otf|eot|so|dylib|dll|exe|bin|dat|class|jar|pyc|wasm|sqlite3?|db)$/i

function FilesSurface({ cwd }: { cwd: string | null }) {
  // Directory contents keyed by path relative to the workspace root ('' = root).
  // Loaded lazily: a folder is only listed the first time it's opened, so a deep
  // tree costs nothing until you actually look inside it.
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // The file being viewed. The panel is narrow, so opening a file drills IN
  // (replacing the tree) rather than splitting the width three ways.
  const [openPath, setOpenPath] = useState<string | null>(null)
  const [file, setFile] = useState<FileState | null>(null)

  const openFile = useCallback(
    async (path: string) => {
      if (!cwd) return
      setOpenPath(path)
      if (BINARY_EXT.test(path)) {
        setFile({ status: 'error', message: "This looks like a binary file — Parallax won't render it as text." })
        return
      }
      setFile({ status: 'loading' })
      try {
        const res = await window.parallax?.agentExec?.({ cwd, actions: [{ type: 'read', path }] })
        const r = res?.results?.[0]
        setFile(
          r?.status === 'ok'
            ? { status: 'ok', content: r.content ?? '' }
            : { status: 'error', message: r?.content || 'Could not read this file.' },
        )
      } catch (err: any) {
        setFile({ status: 'error', message: String(err?.message || err) })
      }
    },
    [cwd],
  )

  const loadDir = useCallback(
    async (path: string) => {
      if (!cwd) return
      setDirs((prev) => ({ ...prev, [path]: { status: 'loading' } }))
      try {
        const res = await window.parallax?.agentExec?.({ cwd, actions: [{ type: 'list', path: path || '.' }] })
        const r = res?.results?.[0]
        setDirs((prev) => ({
          ...prev,
          [path]:
            r?.status === 'ok'
              ? { status: 'ok', entries: (r.content || '').split('\n').filter(Boolean) }
              : { status: 'error', message: r?.content || 'Could not list files.' },
        }))
      } catch (err: any) {
        setDirs((prev) => ({ ...prev, [path]: { status: 'error', message: String(err?.message || err) } }))
      }
    },
    [cwd],
  )

  // Reset and reload the root whenever the workspace folder changes.
  useEffect(() => {
    setDirs({})
    setExpanded(new Set())
    setOpenPath(null)
    setFile(null)
    if (cwd) void loadDir('')
  }, [cwd, loadDir])

  const toggle = useCallback(
    (path: string) => {
      const isOpen = expanded.has(path)
      setExpanded((prev) => {
        const next = new Set(prev)
        if (isOpen) next.delete(path)
        else next.add(path)
        return next
      })
      if (!isOpen && !dirs[path]) void loadDir(path)
    },
    [expanded, dirs, loadDir],
  )

  if (!cwd) {
    return <EmptySurface icon={<FilesIcon />} title="No workspace" hint="Set a folder for this thread to browse its files." />
  }

  function renderDir(path: string, depth: number): React.ReactNode {
    const state = dirs[path]
    const pad = { paddingLeft: `${depth * 12 + 8}px` }
    if (!state || state.status === 'loading') {
      return <div style={pad} className="py-1 text-[11.5px] text-muted-foreground/50">Loading…</div>
    }
    if (state.status === 'error') {
      return <div style={pad} className="py-1 text-[11.5px] text-destructive">{state.message}</div>
    }
    if (state.entries.length === 0) {
      return <div style={pad} className="py-1 text-[11.5px] text-muted-foreground/40">Empty</div>
    }
    // Folders first, then files — each alphabetical, like every other file tree.
    const sorted = [...state.entries].sort((a, b) => {
      const da = a.endsWith('/') ? 0 : 1
      const db = b.endsWith('/') ? 0 : 1
      return da !== db ? da - db : a.localeCompare(b)
    })
    return sorted.map((name) => {
      const isDir = name.endsWith('/')
      const clean = name.replace(/\/$/, '')
      const childPath = path ? `${path}/${clean}` : clean
      const open = expanded.has(childPath)
      return (
        <div key={childPath}>
          <button
            type="button"
            onClick={() => (isDir ? toggle(childPath) : void openFile(childPath))}
            style={pad}
            title={childPath}
            className={cn(
              'flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md pr-2 text-left text-[12.5px] transition-colors hover:bg-accent hover:text-foreground',
              isDir ? 'text-foreground/85' : 'text-muted-foreground',
            )}
          >
            <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground/55">
              {isDir && (
                <svg
                  width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
                  className={cn('transition-transform duration-150', open && 'rotate-90')}
                  aria-hidden
                >
                  <path d="M9 18l6-6-6-6" />
                </svg>
              )}
            </span>
            {isDir ? <FolderMini /> : <FileMini />}
            <span className="truncate">{clean}</span>
          </button>
          {isDir && open && renderDir(childPath, depth + 1)}
        </div>
      )
    })
  }

  if (openPath) {
    return (
      <FileViewer
        path={openPath}
        state={file}
        onBack={() => {
          setOpenPath(null)
          setFile(null)
        }}
      />
    )
  }

  return <div className="h-full overflow-y-auto p-2">{renderDir('', 0)}</div>
}

function FileViewer({
  path,
  state,
  onBack,
}: {
  path: string
  state: FileState | null
  onBack: () => void
}) {
  const name = path.split('/').pop() || path
  // Highlight the whole file once, split into per-line HTML. Recomputed only when
  // the content changes — not on every scroll/hover re-render.
  const lines = useMemo(
    () => (state?.status === 'ok' ? highlightLines(state.content, langForPath(path)) : []),
    [state, path],
  )
  // Gutter width = room for the widest line number PLUS the gutter's own padding.
  //
  // The padding has to be added explicitly: Tailwind sets box-sizing: border-box,
  // so a bare `width: 2ch` means the 1.25rem of padding eats INTO those 2ch,
  // leaving a negative content box — which is why double-digit numbers spilled out
  // over the code. min-width (not width) so the box can never be squeezed below it.
  const digits = String(Math.max(lines.length, 1)).length
  const gutter = `calc(${digits}ch + 1.25rem)` // pl-2 (0.5rem) + pr-3 (0.75rem)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border/70 pl-1 pr-2">
        <button
          type="button"
          onClick={onBack}
          className="flex h-7 items-center gap-1 rounded-md px-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="Back to files"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M15 18l-6-6 6-6" />
          </svg>
          Files
        </button>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground/85" title={path}>
          {name}
        </span>
        {/* An empty file splits to [''] — one entry, zero lines. Don't claim "1 line"
            next to a body that says "Empty file". */}
        {state?.status === 'ok' && state.content !== '' && (
          <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground/55">
            {lines.length} {lines.length === 1 ? 'line' : 'lines'}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {(!state || state.status === 'loading') && (
          <div className="p-3 text-[11.5px] text-muted-foreground/50">Loading…</div>
        )}
        {state?.status === 'error' && (
          <div className="p-3 text-[11.5px] text-destructive">{state.message}</div>
        )}
        {state?.status === 'ok' &&
          (state.content.trim() === '' ? (
            <div className="p-3 text-[11.5px] text-muted-foreground/40">Empty file</div>
          ) : (
            // Each line is its own row so the gutter stays aligned and only the code
            // column scrolls horizontally — line numbers never drift off with it.
            <div className="hljs w-max min-w-full bg-transparent py-1 font-mono text-[11.5px] leading-[1.55]">
              {lines.map((line, i) => (
                <div key={i} className="flex hover:bg-accent/25">
                  <span
                    style={{ minWidth: gutter }}
                    className="shrink-0 select-none whitespace-pre pl-2 pr-3 text-right tabular-nums text-muted-foreground/35"
                  >
                    {i + 1}
                  </span>
                  {/* Pre-highlighted by lib/highlight — hljs output only (spans plus
                      escaped text); no user-authored markup reaches here. */}
                  <span
                    className="whitespace-pre pr-4"
                    dangerouslySetInnerHTML={{ __html: line || ' ' }}
                  />
                </div>
              ))}
            </div>
          ))}
      </div>
    </div>
  )
}

function GlobeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  )
}
function FilesIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" /><path d="M14 2v5h5" />
    </svg>
  )
}
function DiffIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3v14M5 10h14M5 21h14" /><path d="M9 7 12 4l3 3" />
    </svg>
  )
}
function FolderMini() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-muted-foreground/60" aria-hidden>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  )
}
function FileMini() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-muted-foreground/40" aria-hidden>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" /><path d="M14 2v5h5" />
    </svg>
  )
}
