import { useEffect, useRef, useState } from 'react'
import { cn } from '../lib/utils'

// Project "actions" = named shell commands you can run from the top bar, mirroring
// t3code's project scripts. They're scoped per workspace folder and run in the
// terminal via the same sandboxed executor the agent uses.
type ActionIcon = 'play' | 'test' | 'lint' | 'build' | 'configure' | 'debug'

interface Action {
  id: string
  name: string
  command: string
  icon: ActionIcon
}

interface Props {
  cwd: string | null
  onRun: (command: string) => void
}

const ICONS: { id: ActionIcon; label: string }[] = [
  { id: 'play', label: 'Play' },
  { id: 'test', label: 'Test' },
  { id: 'lint', label: 'Lint' },
  { id: 'configure', label: 'Configure' },
  { id: 'build', label: 'Build' },
  { id: 'debug', label: 'Debug' },
]

function storageKey(cwd: string | null) {
  return `parallax:actions:${cwd || '__none__'}`
}

function loadActions(cwd: string | null): Action[] {
  try {
    const raw = localStorage.getItem(storageKey(cwd))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export default function ActionsControl({ cwd, onRun }: Props) {
  const [actions, setActions] = useState<Action[]>([])
  const [menuOpen, setMenuOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [icon, setIcon] = useState<ActionIcon>('play')
  const [error, setError] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setActions(loadActions(cwd))
  }, [cwd])

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  function persist(next: Action[]) {
    setActions(next)
    try {
      localStorage.setItem(storageKey(cwd), JSON.stringify(next))
    } catch {}
  }

  function openAdd() {
    setEditingId(null)
    setName('')
    setCommand('')
    setIcon('play')
    setError(null)
    setDialogOpen(true)
    setMenuOpen(false)
  }

  function openEdit(a: Action) {
    setEditingId(a.id)
    setName(a.name)
    setCommand(a.command)
    setIcon(a.icon)
    setError(null)
    setDialogOpen(true)
    setMenuOpen(false)
  }

  function save() {
    const n = name.trim()
    const c = command.trim()
    if (!n) return setError('Name is required.')
    if (!c) return setError('Command is required.')
    if (editingId) {
      persist(actions.map((a) => (a.id === editingId ? { ...a, name: n, command: c, icon } : a)))
    } else {
      persist([...actions, { id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, name: n, command: c, icon }])
    }
    setDialogOpen(false)
  }

  function remove() {
    if (!editingId) return
    persist(actions.filter((a) => a.id !== editingId))
    setDialogOpen(false)
  }

  function run(a: Action) {
    setMenuOpen(false)
    onRun(a.command)
  }

  const primary = actions[0] || null
  const canRun = Boolean(cwd)

  return (
    <>
      {primary ? (
        <div ref={menuRef} className="relative flex items-center rounded-md border border-border/60 bg-secondary/40">
          <button
            type="button"
            onClick={() => run(primary)}
            disabled={!canRun}
            title={canRun ? `Run ${primary.name}` : 'Open a project first'}
            className="flex h-7 items-center gap-1.5 rounded-l-md px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            <ActionIconGlyph icon={primary.icon} />
            <span className="hidden max-w-[110px] truncate lg:inline">{primary.name}</span>
          </button>
          <span className="h-3.5 w-px bg-border/60" />
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            title="Actions"
            className="flex h-7 items-center rounded-r-md px-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ChevronDownIcon open={menuOpen} />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full z-[1000] mt-1 min-w-[190px] rounded-lg border border-border bg-popover p-1 text-[12.5px] shadow-lg animate-pop-in">
              {actions.map((a) => (
                <div key={a.id} className="group/act relative flex items-center">
                  <button
                    type="button"
                    onClick={() => run(a)}
                    disabled={!canRun}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-2.5 pr-8 text-left text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                  >
                    <ActionIconGlyph icon={a.icon} />
                    <span className="truncate">{a.name}</span>
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      openEdit(a)
                    }}
                    title={`Edit ${a.name}`}
                    className="absolute right-1 grid size-6 place-items-center rounded-md text-muted-foreground/60 opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/act:opacity-100"
                  >
                    <GearIcon />
                  </button>
                </div>
              ))}
              <div className="mx-1 my-1 h-px bg-border" />
              <button
                type="button"
                onClick={openAdd}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <PlusIcon />
                <span>Add action</span>
              </button>
            </div>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={openAdd}
          className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="Add action"
        >
          <PlusIcon />
          <span className="hidden lg:inline">Add action</span>
        </button>
      )}

      {dialogOpen && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
          onClick={() => setDialogOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-2xl animate-pop-in"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 text-[15px] font-semibold text-foreground">
              {editingId ? 'Edit action' : 'Add action'}
            </div>
            <p className="mb-4 text-[12px] text-muted-foreground/70">
              Project-scoped commands you can run from the top bar. They run in the terminal, in this project's folder.
            </p>

            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">Name</label>
            <div className="mb-3 flex items-center gap-2">
              <div className="grid grid-cols-6 gap-1">
                {ICONS.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => setIcon(entry.id)}
                    title={entry.label}
                    className={cn(
                      'grid size-8 place-items-center rounded-md border transition-colors',
                      icon === entry.id ? 'border-primary/70 bg-primary/10 text-foreground' : 'border-border/70 text-muted-foreground hover:bg-accent/60',
                    )}
                  >
                    <ActionIconGlyph icon={entry.id} />
                  </button>
                ))}
              </div>
            </div>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Test"
              className="mb-3 h-9 w-full rounded-lg border border-border bg-background px-3 text-[13px] text-foreground outline-none focus:border-ring/50"
            />

            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">Command</label>
            <textarea
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="pnpm test"
              rows={2}
              className="mb-3 w-full resize-none rounded-lg border border-border bg-background px-3 py-2 font-mono text-[12.5px] text-foreground outline-none focus:border-ring/50"
            />

            {error && <div className="mb-3 text-[12px] text-destructive">{error}</div>}

            <div className="flex items-center justify-end gap-2">
              {editingId && (
                <button
                  type="button"
                  onClick={remove}
                  className="mr-auto rounded-lg border border-destructive/40 px-3 py-1.5 text-[12.5px] font-medium text-destructive transition-colors hover:bg-destructive/10"
                >
                  Delete
                </button>
              )}
              <button
                type="button"
                onClick={() => setDialogOpen(false)}
                className="rounded-lg border border-border px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                className="rounded-lg bg-primary px-3 py-1.5 text-[12.5px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                {editingId ? 'Save changes' : 'Save action'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function ActionIconGlyph({ icon }: { icon: ActionIcon }) {
  const common = { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
  if (icon === 'test') return <svg {...common}><path d="M9 2v6l-5.5 9.5A2 2 0 0 0 5.2 21h13.6a2 2 0 0 0 1.7-3L15 8V2M8.5 2h7M7 14h10" /></svg>
  if (icon === 'lint') return <svg {...common}><path d="m3 17 2 2 4-4M3 7l2 2 4-4M13 6h8M13 12h8M13 18h8" /></svg>
  if (icon === 'build') return <svg {...common}><path d="M14.5 5.5 18 2l4 4-3.5 3.5M14.5 5.5 3 17v4h4L18.5 9.5M14.5 5.5l4 4" /></svg>
  if (icon === 'configure') return <svg {...common}><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z" /></svg>
  if (icon === 'debug') return <svg {...common}><path d="m8 2 1.88 1.88M14.12 3.88 16 2M9 7.13v-1a3.003 3.003 0 1 1 6 0v1M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6M12 20v-9M6.53 9C4.6 8.8 3 7.1 3 5M6 13H2M3 21c0-2.1 1.7-3.9 3.8-4M20.97 5c0 2.1-1.6 3.8-3.5 4M22 13h-4M17.2 17c2.1.1 3.8 1.9 3.8 4" /></svg>
  return <svg {...common} fill="currentColor" stroke="none"><path d="M8 5v14l11-7z" /></svg>
}

function ChevronDownIcon({ open }: { open: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={open ? 'rotate-180' : ''} aria-hidden>
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function GearIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}
