import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import type { Conversation } from '../hooks/useParallax'
import { cn, formatRelativeTime, folderName } from '../lib/utils'
import AppDialog from './AppDialog'

interface Props {
  open: boolean
  conversations: Record<string, Conversation>
  convOrder: string[]
  projects: string[]
  currentConvId: string | null
  workingConversationIds?: ReadonlySet<string>
  onOpenSearch: () => void
  onAddProject: () => void
  onRemoveProject: (path: string) => void
  onNewThread: (folderPath: string | null) => void
  onSwitch: (id: string) => void
  onRename: (ids: string[], name: string) => void
  onDelete: (ids: string[]) => void
  onArchive: (ids: string[]) => void
  onOpenSettings: () => void
}

interface Group {
  key: string
  path: string | null
  name: string
  threads: Conversation[]
}

type CtxMenu =
  | { type: 'thread'; x: number; y: number; convId: string }
  | { type: 'project'; x: number; y: number; path: string | null }

type PendingDialog =
  | { type: 'remove-project'; path: string; name: string; chatCount: number }
  | { type: 'delete-threads'; ids: string[]; titles: string[] }
  | { type: 'rename-threads'; ids: string[]; draft: string }

export default function Sidebar({
  open,
  conversations,
  convOrder,
  projects,
  currentConvId,
  workingConversationIds,
  onOpenSearch,
  onAddProject,
  onRemoveProject,
  onNewThread,
  onSwitch,
  onRename,
  onDelete,
  onArchive,
  onOpenSettings,
}: Props) {
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null)
  const [pendingDialog, setPendingDialog] = useState<PendingDialog | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  // Multi-select for bulk delete: ⇧-click extends a range, ⌘/Ctrl-click toggles one.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const anchorId = useRef<string | null>(null)
  // Start from the constant so SSR and the first client render agree; the saved
  // width is applied in an effect below (reading localStorage in the initializer
  // causes a hydration mismatch on the width style).
  const [sidebarWidth, setSidebarWidth] = useState(256)
  useEffect(() => {
    try {
      const saved = localStorage.getItem('parallax:sidebarWidth')
      if (saved) setSidebarWidth(parseInt(saved, 10))
    } catch {}
  }, [])
  const dragging = useRef(false)
  const startX = useRef(0)
  const startW = useRef(0)

  useEffect(() => {
    function close() {
      setCtxMenu(null)
    }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [])

  // Delete / Backspace ARCHIVES the current multi-selection (unless typing).
  // Archiving, not deleting — a stray Backspace should never destroy threads.
  useEffect(() => {
    if (selectedIds.size === 0) return
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.preventDefault()
      onArchive([...selectedIds])
      setSelectedIds(new Set())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedIds, onArchive])

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!open) return
      dragging.current = true
      startX.current = e.clientX
      startW.current = sidebarWidth
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      function onMove(ev: MouseEvent) {
        if (!dragging.current) return
        const w = Math.max(208, Math.min(400, startW.current + (ev.clientX - startX.current)))
        setSidebarWidth(w)
        localStorage.setItem('parallax:sidebarWidth', String(w))
      }
      function onUp() {
        dragging.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [sidebarWidth, open],
  )

  // Group threads under their project folder. Explicit projects show even when
  // empty; folderless threads collect under an "Ungrouped" group.
  // Only conversations that have started (>= 1 message) are listed. An empty
  // draft (a freshly-opened "new thread") stays invisible until first send —
  // its project is highlighted instead.
  const activeProjectPath = currentConvId ? conversations[currentConvId]?.folderPath ?? null : null

  const { groups, ungrouped, projectCount } = useMemo(() => {
    const byPath = new Map<string, Conversation[]>()
    for (const p of projects) if (!byPath.has(p)) byPath.set(p, [])
    const ungroupedThreads: Conversation[] = []
    for (const id of convOrder) {
      const c = conversations[id]
      if (!c || c.messages.length === 0) continue
      if (c.archived) continue
      if (c.folderPath) {
        if (!byPath.has(c.folderPath)) byPath.set(c.folderPath, [])
        byPath.get(c.folderPath)!.push(c)
      } else {
        ungroupedThreads.push(c)
      }
    }
    const orderedPaths = [
      ...projects,
      ...[...byPath.keys()].filter(p => !projects.includes(p)),
    ]
    const result: Group[] = orderedPaths.map(path => ({
      key: path,
      path,
      name: folderName(path),
      threads: (byPath.get(path) || []).slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
    }))
    return { groups: result, ungrouped: ungroupedThreads, projectCount: orderedPaths.length }
  }, [conversations, convOrder, projects])

  const isExpanded = (key: string) => !collapsed.has(key)
  const toggle = (key: string) =>
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  if (!open) return null

  const allGroups: Group[] =
    ungrouped.length > 0
      ? [...groups, { key: '__ungrouped__', path: null, name: 'Ungrouped', threads: ungrouped }]
      : groups
  const displayedGroups = allGroups

  // Flat, display-ordered thread ids — the axis ⇧-click ranges select along.
  const flatThreadIds = displayedGroups.flatMap(g => g.threads.map(t => t.id))

  function handleThreadClick(e: React.MouseEvent, convId: string) {
    if (e.shiftKey && anchorId.current) {
      const a = flatThreadIds.indexOf(anchorId.current)
      const b = flatThreadIds.indexOf(convId)
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a <= b ? [a, b] : [b, a]
        setSelectedIds(new Set(flatThreadIds.slice(lo, hi + 1)))
        return
      }
    }
    if (e.metaKey || e.ctrlKey) {
      setSelectedIds(prev => {
        const next = new Set(prev)
        next.has(convId) ? next.delete(convId) : next.add(convId)
        return next
      })
      anchorId.current = convId
      return
    }
    // Plain click: open the thread and drop any multi-selection.
    setSelectedIds(new Set())
    anchorId.current = convId
    onSwitch(convId)
  }

  function askToRemoveProject(path: string) {
    setPendingDialog({
      type: 'remove-project',
      path,
      name: folderName(path),
      chatCount: convOrder.filter(id => conversations[id]?.folderPath === path).length,
    })
    setCtxMenu(null)
  }

  function askToDeleteThreads(ids: string[]) {
    setPendingDialog({
      type: 'delete-threads',
      ids,
      titles: ids.map(id => conversations[id]?.title || 'New chat'),
    })
    setCtxMenu(null)
  }

  function askToRenameThreads(ids: string[]) {
    setPendingDialog({
      type: 'rename-threads',
      ids,
      draft: ids.length === 1 ? conversations[ids[0]]?.title || 'New chat' : '',
    })
    setCtxMenu(null)
  }

  return (
    <>
      <div
        className="relative flex shrink-0 flex-col border-r border-border bg-sidebar text-foreground max-md:!w-full max-md:max-h-52 max-md:border-r-0 max-md:border-b"
        style={{ width: sidebarWidth }}
      >
        {/* Brand header */}
        <div className="drag-region flex h-[var(--workspace-topbar-height)] shrink-0 items-center pr-3">
          <div className="no-drag h-full shrink-0" style={{ width: 'var(--workspace-controls-left)' }} aria-hidden />
          <div className="no-drag flex h-7 min-w-0 flex-1 items-center gap-1.5">
            <span className="text-sm font-semibold tracking-tight text-foreground">Parallax</span>
            <span className="shrink-0 whitespace-nowrap rounded-full bg-muted/50 px-1.5 py-0.5 text-[8px] font-medium uppercase tracking-[0.18em] text-muted-foreground/60">
              Alpha
            </span>
          </div>
        </div>

        {/* Scroll area: search + projects */}
        <div className="no-drag flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden">
          {/* Search */}
          <div className="px-2 pt-2 pb-1">
            <button
              type="button"
              onClick={onOpenSearch}
              className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
            >
              <SearchIcon />
              <span className="flex-1 truncate text-left text-xs">Search</span>
              <kbd className="pointer-events-none inline-flex h-4 min-w-0 select-none items-center justify-center gap-1 rounded-sm bg-muted px-1.5 font-sans text-[10px] font-medium text-muted-foreground">
                ⌘K
              </kbd>
            </button>
          </div>

          {/* Projects */}
          <div className="px-2 py-2">
            <div className="mb-1 flex items-center justify-between pl-2 pr-1">
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                Projects
              </span>
              <button
                type="button"
                onClick={onAddProject}
                aria-label="Add project"
                title="Add project"
                className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
              >
                <FolderPlusIcon />
              </button>
            </div>

            {displayedGroups.map(group => (
              <ProjectGroupRow
                key={group.key}
                group={group}
                expanded={isExpanded(group.key)}
                active={group.path === activeProjectPath}
                currentConvId={currentConvId}
                workingConversationIds={workingConversationIds}
                onToggle={() => toggle(group.key)}
                onNewThread={() => onNewThread(group.path)}
                selectedIds={selectedIds}
                onThreadClick={handleThreadClick}
                onArchiveThread={(id) => onArchive([id])}
                onThreadContextMenu={(e, convId) => {
                  e.preventDefault()
                  // Right-clicking a thread outside the current selection resets to it.
                  if (!selectedIds.has(convId)) setSelectedIds(new Set())
                  setCtxMenu({ type: 'thread', x: e.clientX, y: e.clientY, convId })
                }}
                onProjectContextMenu={(e) => {
                  e.preventDefault()
                  setCtxMenu({ type: 'project', x: e.clientX, y: e.clientY, path: group.path })
                }}
              />
            ))}

            {projectCount === 0 && ungrouped.length === 0 && (
              <div className="px-2 pt-4 text-center text-xs text-muted-foreground/60">No projects yet</div>
            )}

          </div>
        </div>

        {/* Multi-select action bar (⇧/⌘-click threads to build a selection) */}
        {selectedIds.size > 0 && (
          <div className="no-drag flex items-center justify-between gap-2 border-t border-border/60 bg-accent/40 px-2 py-1.5">
            <span className="pl-1 text-[11px] font-medium text-foreground">{selectedIds.size} selected</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  onArchive([...selectedIds])
                  setSelectedIds(new Set())
                }}
                className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <ArchiveIcon className="size-3.5" />
                Archive
              </button>
              <button
                type="button"
                onClick={() => setSelectedIds(new Set())}
                title="Clear selection"
                className="grid size-6 place-items-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
              </button>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="no-drag flex items-center justify-between border-t border-border/60 p-2">
          <button
            type="button"
            onClick={onOpenSettings}
            className="flex h-8 items-center gap-2 rounded-lg px-2 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
            title="Settings"
          >
            <SettingsIcon />
            <span className="text-xs">Settings</span>
          </button>
        </div>

        {/* Resize rail */}
        <div
          onMouseDown={onMouseDown}
          className="absolute right-0 top-0 h-full w-1 cursor-col-resize transition-colors hover:bg-border active:bg-primary/40 max-md:hidden"
        />
      </div>

      {ctxMenu && ctxMenu.type === 'thread' && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y}>
          {selectedIds.has(ctxMenu.convId) && selectedIds.size > 1 ? (
            <>
              <MenuButton
                onClick={() => {
                  onArchive([...selectedIds])
                  setSelectedIds(new Set())
                  setCtxMenu(null)
                }}
              >
                Archive {selectedIds.size} conversations
              </MenuButton>
              {/* Deleting many at once stays available, but it is no longer the
                  default action for a multi-selection. */}
              <MenuButton
                destructive
                onClick={() => {
                  askToDeleteThreads([...selectedIds])
                }}
              >
                Delete {selectedIds.size} conversations
              </MenuButton>
            </>
          ) : (
            <>
              <MenuButton onClick={() => askToRenameThreads([ctxMenu.convId])}>Rename</MenuButton>
              <MenuButton onClick={() => { onArchive([ctxMenu.convId]); setCtxMenu(null) }}>Archive</MenuButton>
              <MenuDivider />
              <MenuButton destructive onClick={() => askToDeleteThreads([ctxMenu.convId])}>Delete</MenuButton>
            </>
          )}
        </ContextMenu>
      )}

      {ctxMenu && ctxMenu.type === 'project' && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y}>
          {ctxMenu.path ? (
            <>
              <MenuButton onClick={() => { onNewThread(ctxMenu.path); setCtxMenu(null) }}>New thread</MenuButton>
              <MenuDivider />
              <MenuButton destructive onClick={() => askToRemoveProject(ctxMenu.path as string)}>
                Remove project
              </MenuButton>
            </>
          ) : (
            // "Ungrouped" is a virtual group (folderless legacy threads) — there's
            // no project to remove, so offer to delete the loose threads instead.
            <MenuButton
              destructive
              onClick={() => {
                const ids = ungrouped.map(c => c.id)
                if (ids.length) askToDeleteThreads(ids)
              }}
            >
              Delete these threads
            </MenuButton>
          )}
        </ContextMenu>
      )}

      {pendingDialog?.type === 'remove-project' && (
        <AppDialog
          open
          destructive
          title={`Remove project "${pendingDialog.name}"?`}
          description={
            pendingDialog.chatCount === 0
              ? 'This removes the project from the sidebar.'
              : `This removes the project from the sidebar and archives ${
                  pendingDialog.chatCount === 1
                    ? 'the chat inside it'
                    : `all ${pendingDialog.chatCount} chats inside it`
                }.`
          }
          confirmLabel="Remove project"
          onCancel={() => setPendingDialog(null)}
          onConfirm={() => {
            onRemoveProject(pendingDialog.path)
            setPendingDialog(null)
          }}
        />
      )}

      {pendingDialog?.type === 'delete-threads' && (
        <AppDialog
          open
          destructive
          title={
            pendingDialog.ids.length === 1
              ? `Delete "${pendingDialog.titles[0]}"?`
              : `Delete ${pendingDialog.ids.length} conversations?`
          }
          description="This permanently removes the selected conversation history."
          confirmLabel="Delete"
          onCancel={() => setPendingDialog(null)}
          onConfirm={() => {
            onDelete(pendingDialog.ids)
            setSelectedIds(new Set())
            setPendingDialog(null)
          }}
        />
      )}

      {pendingDialog?.type === 'rename-threads' && (
        <AppDialog
          open
          title={
            pendingDialog.ids.length === 1
              ? 'Rename conversation'
              : `Rename ${pendingDialog.ids.length} conversations`
          }
          confirmLabel="Rename"
          initialFocus={false}
          confirmDisabled={!pendingDialog.draft.trim()}
          onCancel={() => setPendingDialog(null)}
          onConfirm={() => {
            const name = pendingDialog.draft.trim()
            if (!name) return
            onRename(pendingDialog.ids, name)
            setPendingDialog(null)
          }}
        >
          <input
            autoFocus
            value={pendingDialog.draft}
            onChange={(event) =>
              setPendingDialog(current =>
                current?.type === 'rename-threads'
                  ? { ...current, draft: event.target.value }
                  : current,
              )
            }
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || !pendingDialog.draft.trim()) return
              event.preventDefault()
              onRename(pendingDialog.ids, pendingDialog.draft.trim())
              setPendingDialog(null)
            }}
            aria-label="Conversation name"
            className="h-9 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-foreground outline-none focus:border-ring"
          />
        </AppDialog>
      )}
    </>
  )
}

function ProjectGroupRow({
  group,
  expanded,
  currentConvId,
  active,
  workingConversationIds,
  selectedIds,
  onToggle,
  onNewThread,
  onThreadClick,
  onArchiveThread,
  onThreadContextMenu,
  onProjectContextMenu,
}: {
  group: Group
  expanded: boolean
  active?: boolean
  currentConvId: string | null
  workingConversationIds?: ReadonlySet<string>
  selectedIds: Set<string>
  onToggle: () => void
  onNewThread?: () => void
  onThreadClick: (e: React.MouseEvent, convId: string) => void
  onArchiveThread: (id: string) => void
  onThreadContextMenu: (e: React.MouseEvent, convId: string) => void
  onProjectContextMenu?: (e: React.MouseEvent) => void
}) {
  return (
    <div>
      <div className="group/project relative">
        <button
          type="button"
          onClick={onToggle}
          onContextMenu={onProjectContextMenu}
          className={cn(
            'flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2 pr-8 text-left transition-colors hover:bg-accent',
            active && 'bg-accent/60',
          )}
        >
          <ChevronRightIcon className={cn('-ml-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform', expanded && 'rotate-90')} />
          <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
          <span className={cn('min-w-0 flex-1 truncate text-xs font-medium', active ? 'text-foreground' : 'text-foreground/90')}>{group.name}</span>
        </button>
        {onNewThread && (
          <button
            type="button"
            onClick={onNewThread}
            aria-label="New thread"
            title="New thread"
            className="pointer-events-none absolute right-1 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted-foreground/60 opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/project:pointer-events-auto group-hover/project:opacity-100"
          >
            <SquarePenIcon />
          </button>
        )}
      </div>

      {expanded && (
        <div className="mx-1 mb-1 mt-0.5 flex flex-col gap-0.5 px-1.5">
          {group.threads.length === 0 ? (
            <div className="flex h-6 items-center px-2 text-[10px] text-muted-foreground/60">No threads yet</div>
          ) : (
            group.threads.map(conv => {
              const active = conv.id === currentConvId
              const selected = selectedIds.has(conv.id)
              const working = Boolean(workingConversationIds?.has(conv.id))
              const unread = Boolean(conv.unread) && !active
              const title = conv.title || 'New chat'
              return (
                <div key={conv.id} className="group/thread relative">
                  <button
                    onClick={(e) => onThreadClick(e, conv.id)}
                    onContextMenu={(e) => onThreadContextMenu(e, conv.id)}
                    className={cn(
                      'flex h-7 w-full min-w-0 cursor-pointer select-none items-center gap-1.5 rounded-lg px-2 text-left transition-colors',
                      // Every selected row gets the SAME blue — the anchor of a
                      // ⇧-range is also the active thread, and giving it a different
                      // shade made it read as "not selected" next to the others.
                      // Active stays distinguishable by weight, while the inset
                      // outline keeps the selection visible against both themes.
                      selected
                        ? cn(
                            'bg-primary/18 text-foreground ring-1 ring-inset ring-primary/65 hover:bg-primary/24 dark:bg-primary/24 dark:ring-primary/75 dark:hover:bg-primary/30',
                            active && 'font-medium',
                          )
                        : active
                          ? 'bg-accent/85 font-medium text-foreground hover:bg-accent dark:bg-accent/55 dark:hover:bg-accent/70'
                          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                    )}
                  >
                    <span
                      className="min-w-0 flex-1 truncate text-xs"
                      title={title}
                    >
                      {title}
                    </span>
                    {/* Working → unread → timestamp. The status occupies one stable
                        slot, so completion replaces the spinner without shifting
                        the title or archive control. */}
                    <span className="flex h-4 min-w-10 shrink-0 items-center justify-end transition-opacity group-hover/thread:opacity-0">
                      {working ? (
                        <span
                          className="parallax-tool-status-running size-3 animate-spin rounded-full border-2"
                          aria-label={`${title} is working`}
                          data-thread-working
                        />
                      ) : unread ? (
                        <span
                          className="size-2 rounded-full bg-blue-500 ring-2 ring-blue-500/10 dark:bg-blue-400"
                          aria-label={`${title} has an unread response`}
                          data-thread-unread
                        />
                      ) : (
                        <span className={cn('whitespace-nowrap text-[10px] tabular-nums', active ? 'text-foreground/70' : 'text-muted-foreground/40')}>
                          {formatRelativeTime(conv.updatedAt)}
                        </span>
                      )}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Archive ${title}`}
                    title="Archive thread"
                    onClick={(e) => { e.stopPropagation(); onArchiveThread(conv.id) }}
                    className="pointer-events-none absolute right-1 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted-foreground/60 opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/thread:pointer-events-auto group-hover/thread:opacity-100"
                  >
                    <ArchiveIcon />
                  </button>
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}

function ContextMenu({ x, y, children }: { x: number; y: number; children: React.ReactNode }) {
  return (
    <div
      className="fixed z-[1000] min-w-[160px] rounded-lg border border-border bg-popover p-1 text-xs text-popover-foreground shadow-lg animate-pop-in"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  )
}

function MenuButton({ children, onClick, destructive }: { children: React.ReactNode; onClick: () => void; destructive?: boolean }) {
  return (
    <button
      className={cn(
        'flex w-full cursor-pointer items-center rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-accent',
        destructive ? 'text-destructive' : 'text-foreground',
      )}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function MenuDivider() {
  return <div className="mx-1 my-1 h-px bg-border" />
}

function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

function FolderIcon({ className }: { className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  )
}

function FolderPlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 10v6M9 13h6" />
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  )
}

function SquarePenIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground/70" aria-hidden>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  )
}

function ArchiveIcon({ className }: { className?: string }) {
  return (
    <svg className={className || 'size-[13px]'} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect width="20" height="5" x="2" y="3" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <path d="M10 12h4" />
    </svg>
  )
}

function UnarchiveIcon({ className }: { className?: string }) {
  return (
    <svg className={className || 'size-[13px]'} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect width="20" height="5" x="2" y="3" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <path d="m9 13 3-3 3 3" />
      <path d="M12 10v6" />
    </svg>
  )
}

function SettingsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}
