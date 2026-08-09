import useParallax from '../hooks/useParallax'
import Sidebar from '../components/Sidebar'
import MessageLog from '../components/MessageLog'
import InputBar, { requestComposerFocus } from '../components/InputBar'
import CommandPalette, { type Command } from '../components/CommandPalette'
import RightPanel, { type Surface } from '../components/RightPanel'
import TerminalDrawer from '../components/TerminalDrawer'
import ActionsControl from '../components/ActionsControl'
import SettingsModal, { type UpdateStatus } from '../components/SettingsModal'
import { VSCodeIcon, CursorIcon, ZedIcon, IntelliJIcon, FinderIcon } from '../components/EditorIcons'
import { useCallback, useMemo, useRef, useState, useEffect } from 'react'
import { cn } from '../lib/utils'
import ComposerBanner from '../components/ComposerBanner'

export default function Home() {
  const w = useParallax()
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [commandOpen, setCommandOpen] = useState(false)
  const [rightPanelOpen, setRightPanelOpen] = useState(false)
  const [rightSurface, setRightSurface] = useState<Surface>('files')
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({
    status: 'disabled',
    currentVersion: '',
    availableVersion: '',
    progress: null,
    message: 'Update checks are available in installed builds.',
  })
  const [dragOver, setDragOver] = useState(false)
  const [openInOpen, setOpenInOpen] = useState(false)
  const openInRef = useRef<HTMLDivElement>(null)
  const dragCounter = useRef(0)

  useEffect(() => {
    let active = true
    const initial = window.parallax?.getUpdateStatus?.()
    if (initial && typeof initial.then === 'function') {
      initial.then((status: UpdateStatus | null) => {
        if (active && status) setUpdateStatus(status)
      }).catch(() => {})
    }
    const unsubscribe = window.parallax?.onUpdateStatus?.((status: UpdateStatus) => {
      if (active) setUpdateStatus(status)
    })
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setCommandOpen(v => !v)
      }
      // ⌘N / Ctrl+N → a fresh chat with NO folder set.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'n') {
        e.preventDefault()
        w.newConversation(null)
      }
      // ⌘B / ⌘J — the shortcuts the ⌘K palette advertises for these toggles, so
      // the hints it shows are real accelerators rather than decoration.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'b') {
        e.preventDefault()
        setSidebarOpen((v) => !v)
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'j') {
        e.preventDefault()
        setTerminalOpen((v) => !v)
      }
      // ⌘A selects THE CONVERSATION, not the window. Left alone, it swept up all
      // the surrounding chrome — the composer placeholder, "Full access",
      // "Attach", the model name — so copying a reply pasted a pile of UI labels.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'a') {
        const el = document.activeElement as HTMLElement | null
        const tag = el?.tagName
        // Inside a text field ⌘A means "select this field" — that's correct, and
        // hijacking it would break selecting a draft in the composer.
        if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return
        const transcript = document.querySelector('[data-parallax-transcript]')
        if (!transcript) return // no conversation on screen — leave ⌘A alone
        e.preventDefault()
        const range = document.createRange()
        range.selectNodeContents(transcript)
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleFiles = useCallback(
    async (files: FileList) => {
      if (!w.currentConvId) return
      const results: { name: string; data: string; mime: string }[] = []
      for (const file of Array.from(files)) {
        if (file.size > 20 * 1024 * 1024) continue
        if (file.name.match(/\.(zip|tar|gz|gzip|tgz|rar|7z|xz|bz2)$/i)) continue
        const data = await new Promise<string>((resolve) => {
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result as string)
          reader.readAsDataURL(file)
        })
        results.push({ name: file.name, data, mime: file.type })
      }
      if (results.length > 0) w.sendFiles(w.currentConvId, results)
    },
    [w.currentConvId, w.sendFiles],
  )

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
  }

  function handleDragEnter(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current++
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setDragOver(true)
    }
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current--
    if (dragCounter.current === 0) setDragOver(false)
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current = 0
    setDragOver(false)
    if (e.dataTransfer.files.length > 0) void handleFiles(e.dataTransfer.files)
  }

  const hasMessages = Boolean(w.currentConv && w.currentConv.messages.length > 0)
  const currentPendingApproval =
    w.pendingApproval?.convId === w.currentConvId ? w.pendingApproval : null
  const title =
    w.currentConv && w.currentConv.messages.length > 0 ? w.currentConv.title : 'New chat'

  // Per-thread workspace folder — the root the agent harness reads/searches in.
  const currentFolder = w.currentConv?.folderPath || null

  useEffect(() => {
    window.__parallax_project_cwd__ = currentFolder || ''
  }, [currentFolder])

  // Open-in picker: which editors are installed + the macOS default for .py.
  const [editors, setEditors] = useState<string[]>(['vscode', 'cursor', 'zed', 'idea', 'file-manager'])
  // Start from a constant so SSR and the first client render agree; the persisted
  // choice is read from localStorage in an effect below (reading it in the useState
  // initializer causes a hydration mismatch — different icon server vs client).
  const [preferredEditor, setPreferredEditor] = useState<string>('vscode')
  // A topbar "action" (or Commit & push) pushes a command into the terminal.
  const [actionRun, setActionRun] = useState<{ cmd: string; nonce: number }>({ cmd: '', nonce: 0 })

  // Is the current folder a git repo? Drives the topbar button: "Commit & push"
  // vs "Initialize Git" (matching t3code). Detected read-only by listing the
  // folder and checking for a .git entry — no shell command, so no permission gate.
  const [isGitRepo, setIsGitRepo] = useState<boolean | null>(null)
  const checkGit = useCallback(async () => {
    if (!currentFolder) { setIsGitRepo(null); return }
    try {
      const res = await window.parallax?.agentExec?.({ cwd: currentFolder, actions: [{ type: 'list', path: '.' }] })
      const content: string = res?.results?.[0]?.content || ''
      setIsGitRepo(/(^|\n)\.git\/?(\r?\n|$)/.test(content))
    } catch {
      setIsGitRepo(null)
    }
  }, [currentFolder])
  useEffect(() => { void checkGit() }, [checkGit])

  useEffect(() => {
    let cancelled = false
    try {
      const s = localStorage.getItem('parallax:preferredEditor')
      if (s) setPreferredEditor(s)
    } catch {}
    ;(async () => {
      try {
        const res = await window.parallax?.detectEditors?.()
        if (cancelled || !res) return
        const opts = [...(res.available || []), 'file-manager']
        setEditors(opts.length ? opts : ['file-manager'])
        const saved = localStorage.getItem('parallax:preferredEditor')
        const pick =
          saved && opts.includes(saved) ? saved : res.default && opts.includes(res.default) ? res.default : opts[0]
        if (pick) {
          setPreferredEditor(pick)
          try { localStorage.setItem('parallax:preferredEditor', pick) } catch {}
        }
      } catch {}
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!openInOpen) return
    function onDown(e: MouseEvent) {
      if (openInRef.current && !openInRef.current.contains(e.target as Node)) setOpenInOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [openInOpen])

  const handleOpen = useCallback(
    (editorId: string) => {
      if (!currentFolder) return
      setPreferredEditor(editorId)
      try { localStorage.setItem('parallax:preferredEditor', editorId) } catch {}
      window.parallax?.openInEditor?.(editorId, currentFolder)
    },
    [currentFolder],
  )

  const runAction = useCallback((cmd: string) => {
    setTerminalOpen(true)
    setActionRun({ cmd, nonce: Date.now() })
  }, [])

  const availableOptions = EDITOR_OPTIONS.filter((o) => editors.includes(o.id))
  const primaryOption = availableOptions.find((o) => o.id === preferredEditor) || availableOptions[0] || null

  // ⌘K commands. Built here because this is where the panel state lives; the
  // palette is just a list. Toggle labels say what the action DOES ("Hide
  // sidebar" when it's open), so the row is never ambiguous.
  const paletteCommands: Command[] = useMemo(() => {
    const setTheme = (mode: 'light' | 'dark') => {
      try { localStorage.setItem('parallax:theme', mode) } catch {}
      document.documentElement.classList.toggle('dark', mode === 'dark')
    }
    const showPanel = (s: Surface) => {
      // Already open on this surface? Then the useful action is to close it.
      if (rightPanelOpen && rightSurface === s) setRightPanelOpen(false)
      else { setRightSurface(s); setRightPanelOpen(true) }
    }
    return [
      // View
      {
        id: 'toggle-sidebar', group: 'View', hint: '⌘B',
        label: sidebarOpen ? 'Hide sidebar' : 'Show sidebar',
        keywords: 'sidebar threads list collapse expand navigation',
        run: () => setSidebarOpen((v) => !v),
      },
      {
        id: 'toggle-terminal', group: 'View', hint: '⌘J',
        label: terminalOpen ? 'Hide terminal' : 'Open terminal',
        keywords: 'terminal shell console command drawer bash',
        run: () => setTerminalOpen((v) => !v),
      },
      {
        id: 'panel-files', group: 'View',
        label: rightPanelOpen && rightSurface === 'files' ? 'Hide files' : 'Open files',
        keywords: 'files tree explorer right panel sidebar browse',
        run: () => showPanel('files'),
      },
      {
        id: 'panel-browser', group: 'View',
        label: rightPanelOpen && rightSurface === 'browser' ? 'Hide browser' : 'Open browser',
        keywords: 'browser preview web right panel localhost',
        run: () => showPanel('browser'),
      },
      {
        id: 'panel-diff', group: 'View',
        label: rightPanelOpen && rightSurface === 'diff' ? 'Hide diff' : 'Open diff',
        keywords: 'diff changes git right panel',
        run: () => showPanel('diff'),
      },
      // Thread
      {
        id: 'new-chat', group: 'Thread', hint: '⌘N', label: 'New chat',
        keywords: 'thread conversation start create',
        run: () => w.newConversation(null),
      },
      {
        id: 'add-project', group: 'Thread', label: 'Add project folder',
        keywords: 'workspace folder directory open project',
        run: () => w.addProject(),
      },
      ...(currentFolder && primaryOption
        ? [{
            id: 'open-editor', group: 'Thread',
            label: `Open in ${primaryOption.label}`,
            keywords: 'editor vscode cursor zed reveal finder',
            run: () => handleOpen(primaryOption.id),
          } as Command]
        : []),
      // Appearance
      { id: 'theme-dark', group: 'Appearance', label: 'Set dark mode', keywords: 'theme appearance night', run: () => setTheme('dark') },
      { id: 'theme-light', group: 'Appearance', label: 'Set light mode', keywords: 'theme appearance white day', run: () => setTheme('light') },
      { id: 'settings', group: 'Appearance', label: 'Open settings', keywords: 'preferences config access permissions', run: () => setSettingsOpen(true) },
      // Danger
      { id: 'delete-all', group: 'Danger', label: 'Delete all conversations', keywords: 'clear wipe remove reset', run: () => setSettingsOpen(true) },
    ]
  }, [sidebarOpen, terminalOpen, rightPanelOpen, rightSurface, currentFolder, primaryOption, handleOpen, w])


  return (
    <div className="relative isolate flex h-screen overflow-hidden bg-background text-foreground max-md:flex-col">
      {/* One persistent control prevents its hit target from moving across states. */}
      <div
        className="pointer-events-none fixed left-[var(--workspace-sidebar-toggle-left)] top-0 z-50 flex h-[var(--workspace-topbar-height)] items-center"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <button
          type="button"
          onClick={() => setSidebarOpen(open => !open)}
          className="no-drag pointer-events-auto grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          title={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          data-sidebar-toggle
          data-sidebar-expand={sidebarOpen ? undefined : ''}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d={sidebarOpen ? 'M9 3v18' : 'M15 3v18'} />
          </svg>
        </button>
      </div>

      <Sidebar
        open={sidebarOpen}
        conversations={w.conversations}
        convOrder={w.convOrder}
        projects={w.projects}
        currentConvId={w.currentConvId}
        workingConversationIds={w.workingConversationIds}
        onOpenSearch={() => setCommandOpen(true)}
        onAddProject={w.addProject}
        onRemoveProject={w.removeProject}
        onNewThread={(folderPath) => w.newConversation(folderPath)}
        onSwitch={w.switchConversation}
        onRename={w.renameConv}
        onDelete={w.deleteConv}
        onArchive={w.archiveConv}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <div
        className="relative flex min-w-0 flex-1 flex-col bg-background"
        onDragOver={handleDragOver}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {dragOver && (
          <div className="absolute inset-0 z-40 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm">
            <div className="flex items-center gap-3 rounded-xl border border-dashed border-border bg-card px-5 py-4 text-foreground animate-pop-in">
              <svg
                className="text-primary"
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
              </svg>
              <span className="text-[13px] font-medium">Drop files to attach</span>
            </div>
          </div>
        )}

        {/* Workspace topbar */}
        <header className="workspace-topbar drag-region border-b border-border pl-4 pr-4 sm:pl-5 sm:pr-5">
          {/* When the sidebar is collapsed the toggle overlays this header; a non-draggable
              gutter carves the drag region away so the toggle stays clickable in Electron. */}
          {!sidebarOpen && (
            <div
              className="no-drag h-full shrink-0"
              style={{ width: 'calc(var(--workspace-sidebar-toggle-left) + 1rem)' }}
              aria-hidden
            />
          )}
          <div className="no-drag flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground" data-thread-title>{title}</span>
            {w.currentConv && (
              hasMessages ? (
                // A started chat's folder is fixed — show it read-only.
                currentFolder && (
                  <span
                    title={currentFolder}
                    className="flex h-6 shrink-0 items-center gap-1.5 rounded-md bg-muted/60 px-2 text-[11px] font-medium text-muted-foreground"
                  >
                    <FolderIcon />
                    <span className="max-w-[160px] truncate">{currentFolder.split('/').filter(Boolean).pop()}</span>
                  </span>
                )
              ) : (
                // Only a new chat can still choose/change its workspace folder.
                <FolderPicker
                  folder={currentFolder}
                  projects={w.projects}
                  onPick={(p) => w.currentConvId && w.setFolderPath(w.currentConvId, p)}
                  onChoose={() => w.currentConvId && w.chooseFolder(w.currentConvId)}
                  onClear={() => w.currentConvId && w.setFolderPath(w.currentConvId, null)}
                />
              )
            )}
          </div>
          <div className="no-drag flex shrink-0 items-center gap-1.5">
            <ActionsControl cwd={currentFolder} onRun={runAction} />

            <div ref={openInRef} className="relative">
              <div className="flex items-center rounded-md border border-border/60 bg-secondary/40 text-[11px] font-medium text-muted-foreground">
                <button
                  type="button"
                  onClick={() => primaryOption && handleOpen(primaryOption.id)}
                  disabled={!currentFolder || !primaryOption}
                  className="flex h-7 items-center gap-1.5 rounded-l-md px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                  title={currentFolder ? `Open in ${primaryOption?.label ?? 'editor'}` : 'Open a project first'}
                >
                  {primaryOption ? <primaryOption.icon className="size-3.5" /> : <OpenInIcon />}
                  <span className="hidden sm:inline">Open</span>
                </button>
                <span className="h-3.5 w-px bg-border/60" />
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setOpenInOpen((v) => !v) }}
                  className="flex h-7 items-center rounded-r-md px-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  title="Choose editor"
                >
                  <ChevronDownIcon open={openInOpen} />
                </button>
              </div>
              {openInOpen && (
                <div
                  className="absolute right-0 top-full z-[1000] mt-1 min-w-[168px] rounded-lg border border-border bg-popover p-1 text-[12.5px] shadow-lg animate-pop-in"
                  onClick={(e) => e.stopPropagation()}
                >
                  {availableOptions.length === 0 && (
                    <div className="px-2.5 py-1.5 text-muted-foreground/60">No editors found</div>
                  )}
                  {availableOptions.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      disabled={!currentFolder}
                      onClick={() => {
                        setOpenInOpen(false)
                        handleOpen(opt.id)
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                    >
                      <opt.icon className="size-3.5 text-muted-foreground" />
                      <span>{opt.label}</span>
                      {opt.id === preferredEditor && <CheckIcon />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {isGitRepo === false ? (
              <button
                type="button"
                onClick={() => { runAction('git init && git add -A && git status'); setTimeout(() => void checkGit(), 2500) }}
                disabled={!currentFolder}
                className="flex h-7 items-center gap-1.5 rounded-md border border-border/60 bg-secondary/40 px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                title="Initialize a git repository in this folder"
              >
                <GitBranchPlusIcon />
                <span className="hidden lg:inline">Initialize Git</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => runAction('git add -A && git status && echo "--- run: git commit -m <msg> && git push ---"')}
                disabled={!currentFolder}
                className="flex h-7 items-center gap-1.5 rounded-md border border-border/60 bg-secondary/40 px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                title="Stage changes &amp; show status in the terminal"
              >
                <CommitIcon />
                <span className="hidden lg:inline">Commit &amp; push</span>
              </button>
            )}

            <span className="mx-0.5 h-4 w-px bg-border/60" />

            <button
              type="button"
              onClick={() => setTerminalOpen((v) => !v)}
              className={`grid size-7 place-items-center rounded-md transition-colors hover:bg-accent hover:text-foreground ${terminalOpen ? 'bg-accent text-foreground' : 'text-muted-foreground'}`}
              title="Toggle terminal"
            >
              <TerminalIcon />
            </button>
            <button
              type="button"
              onClick={() => setRightPanelOpen((v) => !v)}
              className={`grid size-7 place-items-center rounded-md transition-colors hover:bg-accent hover:text-foreground ${rightPanelOpen ? 'bg-accent text-foreground' : 'text-muted-foreground'}`}
              title="Toggle panel"
            >
              <PanelRightIcon />
            </button>
          </div>
        </header>

        {/* Row: chat column + optional right panel */}
        <div className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col">
        <div className="parallax-main-panel flex min-h-0 flex-1 flex-col" data-main-panel>
        {/* Main chat column */}
        {w.currentConv ? (
          <>
            <MessageLog
              conversation={w.currentConv}
              sending={w.currentConversationSending && hasMessages}
              onEditMessage={w.currentConversationSending ? undefined : w.editMessage}
            />

            {/* Composer banners — a Codex-style stack sitting flush above the input,
                same width as it. Connection state warns (amber) instead of forcing a
                new chat; runtime errors show red. */}
            {(w.extensionDisconnected || w.errorMessage) && (
              <div className="chat-composer-horizontal-inset shrink-0 pb-1.5">
                {/* Same width + centering as the InputBar <form> below, so the bars
                    line up exactly with the composer instead of running full-bleed. */}
                <div className="mx-auto w-full max-w-3xl space-y-1.5">
                  {w.extensionDisconnected && (
                    <ComposerBanner
                      tone="warning"
                      title="Extension not connected"
                      detail={
                        w.queuedNotice
                          ? 'Your message is queued — it’ll send automatically the moment the Parallax extension reconnects.'
                          : 'Open ChatGPT and check the Parallax extension. You can keep typing here — messages send as soon as it reconnects.'
                      }
                    />
                  )}
                  {w.errorMessage && <ComposerBanner tone="error" title={w.errorMessage} />}
                </div>
              </div>
            )}
            <div className="chat-composer-horizontal-inset shrink-0 pb-3 pt-1 sm:pb-4">
              <InputBar
                sending={w.currentConversationSending}
                queueing={w.sending}
                queuedCount={w.currentQueuedMessageCount}
                queuedMessages={w.currentQueuedMessages}
                currentConvId={w.currentConvId}
                onSend={w.send}
                onStop={w.stopSending}
                onEditQueuedMessage={w.editQueuedMessage}
                onDeleteQueuedMessage={w.deleteQueuedMessage}
                gptModel={w.gptModel}
                onSetGptModel={w.setGptModel}
                availableModels={w.availableModels}
                intelligence={w.intelligenceLevel}
                selectionStatus={w.selectionStatus}
                onSetIntelligence={w.setIntelligenceLevel}
                permission={w.permissionLevel}
                onSetPermission={w.setPermissionLevel}
                pendingApproval={currentPendingApproval}
                onApprove={w.approvePending}
                onDeny={w.denyPending}
                emptyState={!hasMessages}
              />
            </div>
          </>
        ) : !w.dataLoaded ? (
          // Persisted threads haven't been read off disk yet — hold a blank rather
          // than flashing "Add a project to get started" on every ⌘R.
          <div className="flex flex-1" aria-hidden />
        ) : w.projects.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
            <div className="grid size-12 place-items-center rounded-2xl border border-border/70 bg-card text-muted-foreground">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
              </svg>
            </div>
            <div className="space-y-1">
              <div className="text-xl font-medium text-foreground">Add a project to get started</div>
              <p className="max-w-sm text-sm text-muted-foreground/78">
                Pick a folder to work in. Parallax reads and reasons over it, and your threads live inside the project.
              </p>
            </div>
            <button
              type="button"
              onClick={w.addProject}
              className="flex items-center gap-2 rounded-lg border border-primary bg-primary px-3.5 py-2 text-[13px] font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 10v6M9 13h6" />
                <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
              </svg>
              Add project
            </button>
          </div>
        ) : (
          <MessageLog conversation={null} />
        )}
        </div>
        <TerminalDrawer open={terminalOpen} cwd={currentFolder} onClose={() => { setTerminalOpen(false); requestComposerFocus() }} runSignal={actionRun} />
        </div>
        <RightPanel
          open={rightPanelOpen}
          cwd={currentFolder}
          conversationId={w.currentConvId}
          surface={rightSurface}
          onSurface={setRightSurface}
          onClose={() => { setRightPanelOpen(false); requestComposerFocus() }}
        />
        </div>
      </div>

      <CommandPalette
        open={commandOpen}
        onClose={() => { setCommandOpen(false); requestComposerFocus() }}
        conversations={w.conversations}
        convOrder={w.convOrder}
        onSwitch={w.switchConversation}
        commands={paletteCommands}
      />

      <SettingsModal
        open={settingsOpen}
        onClose={() => { setSettingsOpen(false); requestComposerFocus() }}
        permission={w.permissionLevel}
        onSetPermission={w.setPermissionLevel}
        serverStatus={w.serverStatus}
        wsStatus={w.wsStatus}
        chatgptStatus={w.chatgptStatus}
        conversations={w.conversations}
        convOrder={w.convOrder}
        onUnarchive={w.unarchiveConv}
        onDeleteAll={w.deleteAllConversations}
        updateStatus={updateStatus}
        onCheckForUpdates={() => { void window.parallax?.checkForUpdates?.() }}
        onInstallUpdate={() => window.parallax?.installUpdate?.()}
      />
    </div>
  )
}

const EDITOR_OPTIONS = [
  { id: 'vscode', label: 'VS Code', icon: VSCodeIcon },
  { id: 'cursor', label: 'Cursor', icon: CursorIcon },
  { id: 'zed', label: 'Zed', icon: ZedIcon },
  { id: 'idea', label: 'IntelliJ IDEA', icon: IntelliJIcon },
  { id: 'file-manager', label: 'Finder', icon: FinderIcon },
] as const

function ChevronDownIcon({ open }: { open: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={open ? 'rotate-180' : ''} aria-hidden>
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}

function OpenInIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  )
}

function FolderIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  )
}

// Topbar control to set / change / clear the current chat's workspace folder.
function FolderPicker({
  folder,
  projects,
  onPick,
  onChoose,
  onClear,
}: {
  folder: string | null
  projects: string[]
  onPick: (path: string) => void
  onChoose: () => void
  onClear: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  const name = folder ? folder.split('/').filter(Boolean).pop() || folder : null
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={folder || 'Set a workspace folder for this chat'}
        className={cn(
          'flex h-6 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium transition-colors',
          folder
            ? 'bg-muted/60 text-muted-foreground hover:bg-accent hover:text-foreground'
            : 'border border-dashed border-border/70 text-muted-foreground/70 hover:bg-accent hover:text-foreground',
        )}
      >
        <FolderIcon />
        <span className="max-w-[160px] truncate">{name || 'Set folder'}</span>
        <ChevronDownIcon open={open} />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-[1000] mt-1 min-w-[204px] rounded-lg border border-border bg-popover p-1 text-[12.5px] shadow-lg animate-pop-in">
          {projects.length > 0 && (
            <>
              <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
                Projects
              </div>
              {projects.map((p) => {
                const pname = p.split('/').filter(Boolean).pop() || p
                const active = p === folder
                return (
                  <button
                    key={p}
                    type="button"
                    title={p}
                    onClick={() => { onPick(p); setOpen(false) }}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-accent',
                      active ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    <FolderIcon />
                    <span className="min-w-0 flex-1 truncate">{pname}</span>
                    {active && <CheckIcon />}
                  </button>
                )
              })}
              <div className="mx-1 my-1 h-px bg-border" />
            </>
          )}
          <button
            type="button"
            onClick={() => { onChoose(); setOpen(false) }}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
              <path d="M12 10v6M9 13h6" />
            </svg>
            <span>Choose folder…</span>
          </button>
          {folder && (
            <button
              type="button"
              onClick={() => { onClear(); setOpen(false) }}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
              <span>No folder</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function CommitIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" /><path d="M3 12h6M15 12h6" />
    </svg>
  )
}

// Git-branch-plus (matches t3code's "Initialize Git" affordance).
function GitBranchPlusIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 3v12" />
      <circle cx="6" cy="18" r="3" />
      <path d="M15 6a9 9 0 0 0-9 9" />
      <path d="M18 3v6M15 6h6" />
    </svg>
  )
}

function TerminalIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m4 17 6-6-6-6M12 19h8" />
    </svg>
  )
}

function PanelRightIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M15 3v18" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="ml-auto text-primary" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}
