import { useState, useRef, useCallback, useEffect } from 'react'
import type {
  PermissionLevel,
  ModelOption,
  ModelSelectionStatus,
  PendingApproval,
} from '../hooks/useParallax'
import { agentActionLabel } from '../lib/agentProtocol'
import { cn } from '../lib/utils'
import {
  PREVIEW_ANNOTATION_EVENT,
  PREVIEW_CAPTURE_EVENT,
  annotationLabel,
  buildPreviewAnnotationPrompt,
  type PreviewAnnotation,
  type PreviewCapture,
} from '../lib/previewAnnotations'
import { PERMISSION_OPTIONS, permissionOption } from './permissions'

/**
 * Ask the composer to take focus back. Fired by anything that steals it — the ⌘K
 * palette, Settings, the terminal drawer, the right panel — so focus always
 * settles back on the input rather than being left on a dismissed overlay (where
 * the next keystroke would go nowhere).
 */
export const FOCUS_COMPOSER_EVENT = 'parallax:focus-composer'

export function requestComposerFocus() {
  window.dispatchEvent(new Event(FOCUS_COMPOSER_EVENT))
}

interface Props {
  sending: boolean
  /** The shared browser transport is busy, even if another chat owns it. */
  queueing?: boolean
  queuedMessages?: QueuedMessage[]
  currentConvId: string | null
  onSend: (
    text: string,
    model?: string,
    intelligence?: string,
    context?: string,
    attachments?: AttachedFile[],
  ) => void
  onStop?: () => void
  onEditQueuedMessage?: (messageId: string, text: string) => boolean | void
  onDeleteQueuedMessage?: (messageId: string) => void
  gptModel: string
  onSetGptModel: (v: string) => void
  availableModels: ModelOption[]
  intelligence: string
  selectionStatus: ModelSelectionStatus
  onSetIntelligence: (v: string) => void
  permission: PermissionLevel
  onSetPermission: (v: PermissionLevel) => void
  pendingApproval?: PendingApproval | null
  onApprove?: () => void
  onDeny?: () => void
  emptyState?: boolean
}

interface AttachedFile {
  name: string
  data: string
  mime: string
}

interface QueuedMessage {
  id: string
  text: string
}

export default function InputBar({
  sending,
  queueing = sending,
  queuedMessages = [],
  currentConvId,
  onSend,
  onStop,
  onEditQueuedMessage,
  onDeleteQueuedMessage,
  gptModel,
  onSetGptModel,
  availableModels,
  intelligence,
  selectionStatus,
  onSetIntelligence,
  permission,
  onSetPermission,
  pendingApproval,
  onApprove,
  onDeny,
  emptyState,
}: Props) {
  // Clean, flat model list — ChatGPT's real names, one row each (no synthetic
  // families / intelligence variants; that was the source of the duplicate mess).
  const models = availableModels.length ? availableModels : [{ slug: gptModel, title: gptModel }]
  const selectedModel: ModelOption =
    models.find((m) => m.slug === gptModel || m.title === gptModel) ||
    { slug: gptModel, title: gptModel }
  const selectedTitle = selectedModel?.title || gptModel
  // Per-model Intelligence tiers, scraped from ChatGPT's live menu (empty until seen).
  const intelligenceOptions = selectedModel?.intelligences ?? []
  const activeIntelligenceOption = intelligenceOptions.find((o) => o.label === intelligence)
  const activeIntelligence = activeIntelligenceOption?.label ?? intelligence
  // Match ChatGPT's compact composer control. The model row is a family/picker
  // entry; the selected Intelligence row carries the runtime label and version
  // hint (for example, "Instant 5.5").
  const pickerLabel = activeIntelligenceOption
    ? [activeIntelligenceOption.label, activeIntelligenceOption.hint].filter(Boolean).join(' ')
    : activeIntelligence || selectedTitle
  const [text, setText] = useState('')
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([])
  const [previewAnnotations, setPreviewAnnotations] = useState<PreviewAnnotation[]>([])
  const [modelOpen, setModelOpen] = useState(false)
  const [permissionOpen, setPermissionOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [previewFile, setPreviewFile] = useState<AttachedFile | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const modelRef = useRef<HTMLDivElement>(null)
  const permissionRef = useRef<HTMLDivElement>(null)
  const approvalRef = useRef<HTMLDivElement>(null)
  const hadApprovalRef = useRef(false)
  const approvalAction = pendingApproval?.actions[0]
  const approvalKey = approvalAction
    ? `${pendingApproval?.convId ?? ''}:${agentActionLabel(approvalAction)}`
    : null
  const [displayedApproval, setDisplayedApproval] = useState<{
    key: string
    action: PendingApproval['actions'][number]
  } | null>(null)
  const [approvalLeaving, setApprovalLeaving] = useState(false)

  const focusComposer = useCallback(() => {
    // Deferred by one macrotask so focus lands AFTER the current commit — an
    // overlay closing in this same tick would otherwise blur us right back.
    //
    // setTimeout, NOT requestAnimationFrame: rAF does not fire at all while the
    // window is hidden or backgrounded, so an rAF-scheduled focus would sit queued
    // forever and the composer would come back dead. setTimeout always runs.
    setTimeout(() => {
      const ta = textareaRef.current
      if (ta && ta !== document.activeElement) ta.focus()
    }, 0)
  }, [])

  // Focus belongs in the composer by default — on first paint, on every thread
  // switch, and on a brand-new chat. The old `if (currentConvId)` guard meant a
  // freshly opened app (no thread selected yet) started with focus nowhere, so the
  // first thing you typed went into the void.
  useEffect(() => {
    focusComposer()
  }, [currentConvId])

  // Anything that takes focus away — the ⌘K palette, Settings, the terminal
  // drawer, the right panel — hands it back by firing this.
  useEffect(() => {
    const onFocusRequest = () => focusComposer()
    window.addEventListener(FOCUS_COMPOSER_EVENT, onFocusRequest)
    return () => window.removeEventListener(FOCUS_COMPOSER_EVENT, onFocusRequest)
  }, [])

  useEffect(() => {
    if (approvalKey) {
      hadApprovalRef.current = true
      setModelOpen(false)
      setPermissionOpen(false)
      approvalRef.current?.focus({ preventScroll: true })
      return
    }
    if (hadApprovalRef.current) {
      hadApprovalRef.current = false
    }
  }, [approvalKey, focusComposer])

  // Keep the approval surface mounted briefly after a decision so it can contract
  // back into the composer instead of disappearing between two frames.
  useEffect(() => {
    if (approvalAction && approvalKey) {
      setDisplayedApproval({ key: approvalKey, action: approvalAction })
      setApprovalLeaving(false)
      return
    }
    if (!displayedApproval) return
    setApprovalLeaving(true)
    const timer = window.setTimeout(() => {
      setDisplayedApproval(null)
      setApprovalLeaving(false)
      focusComposer()
    }, 220)
    return () => window.clearTimeout(timer)
  }, [approvalAction, approvalKey, displayedApproval?.key, focusComposer])

  // Type-to-focus: start typing anywhere that isn't already a text field and the
  // keystroke lands in the composer, the way every chat app behaves. Focusing
  // during keydown means the character itself still arrives, so nothing is lost.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return // a shortcut, not typing
      if (e.key.length !== 1) return // Escape/Tab/arrows/F-keys stay untouched
      const el = e.target as HTMLElement | null
      if (!el) return
      const tag = el.tagName
      // Already somewhere text goes — a field, a dropdown, or a modal's own input.
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return
      // Don't reach through an open dialog to the composer behind it.
      if (el.closest('[role="dialog"], [role="menu"], [role="listbox"]')) return
      const ta = textareaRef.current
      if (!ta || ta === document.activeElement) return
      ta.focus()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    const onAnnotation = (event: Event) => {
      const annotation = (event as CustomEvent<PreviewAnnotation>).detail
      if (!annotation?.id) return
      setPreviewAnnotations((current) => [
        ...current.filter((item) => item.id !== annotation.id),
        annotation,
      ])
      focusComposer()
    }
    const onCapture = (event: Event) => {
      const capture = (event as CustomEvent<PreviewCapture>).detail
      if (!capture?.id || !capture.dataUrl) return
      setAttachedFiles((current) => [
        ...current,
        { name: capture.name, data: capture.dataUrl, mime: capture.mime },
      ])
      focusComposer()
    }
    window.addEventListener(PREVIEW_ANNOTATION_EVENT, onAnnotation)
    window.addEventListener(PREVIEW_CAPTURE_EVENT, onCapture)
    return () => {
      window.removeEventListener(PREVIEW_ANNOTATION_EVENT, onAnnotation)
      window.removeEventListener(PREVIEW_CAPTURE_EVENT, onCapture)
    }
  }, [])

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    const results: AttachedFile[] = []
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
    setAttachedFiles((prev) => [...prev, ...results])
  }, [])

  // Pick a model using the exact title exposed by ChatGPT's live menu.
  function selectModel(m: ModelOption) {
    onSetGptModel(m.slug)
    setModelOpen(false)
  }

  function handleSend() {
    const trimmed = text.trim()
    const annotations = [...previewAnnotations]
    const annotationContext = annotations.map(buildPreviewAnnotationPrompt).join('\n\n')
    const annotationFiles: AttachedFile[] = annotations.flatMap((annotation) =>
      annotation.screenshot
        ? [{
            name: `preview-annotation-${annotation.id}.png`,
            data: annotation.screenshot.dataUrl,
            mime: 'image/png',
          }]
        : [],
    )
    const files = [...attachedFiles, ...annotationFiles]
    const message =
      trimmed ||
      (annotations.length
        ? 'Apply the attached preview annotations.'
        : files.length
          ? 'Review the attached file.'
          : '')
    if ((!message && files.length === 0) || !currentConvId) return

    if (message) {
      onSend(
        message,
        gptModel,
        activeIntelligence || undefined,
        annotationContext || undefined,
        files.length ? files : undefined,
      )
      setAttachedFiles([])
      setPreviewAnnotations([])
    }

    setText('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
    // Sending must never cost you the caret — you should be able to keep typing
    // straight away. Matters most when Send was CLICKED, which moves focus to the
    // button.
    focusComposer()
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setText(e.target.value)
    e.target.style.height = 'auto'
    e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px'
  }

  function removeFile(idx: number) {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== idx))
  }

  function removePreviewAnnotation(id: string) {
    setPreviewAnnotations((current) => current.filter((annotation) => annotation.id !== id))
  }

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) setModelOpen(false)
      if (permissionRef.current && !permissionRef.current.contains(e.target as Node)) setPermissionOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const canSend = Boolean(text.trim() || attachedFiles.length > 0 || previewAnnotations.length > 0)
  const placeholder = emptyState ? 'Ask anything…' : 'Ask for follow-up changes or attach files'

  const visibleApprovalAction = approvalAction ?? displayedApproval?.action
  const queueSurface = (
    <QueuedMessageList
      messages={queuedMessages}
      onEdit={onEditQueuedMessage}
      onDelete={onDeleteQueuedMessage}
    />
  )
  if (visibleApprovalAction) {
    const actionLabel = agentActionLabel(visibleApprovalAction)
    const approveLabel = visibleApprovalAction.type === 'write' ? 'Apply' : 'Run'
    return (
      <div className="mx-auto w-full min-w-0 max-w-3xl">
        {queueSurface}
        <form
          className="parallax-approval-frame min-w-0"
          data-approval-state={approvalLeaving ? 'leaving' : 'entering'}
          onSubmit={(event) => event.preventDefault()}
        >
          <div className="group rounded-[22px] p-px">
            <div className="parallax-composer-shell parallax-approval-surface min-h-[108px] overflow-hidden rounded-[24px] border">
              <div
                ref={approvalRef}
                role="alertdialog"
                aria-label={`Approval required: ${actionLabel}`}
                tabIndex={-1}
                className="parallax-approval-content flex min-h-[106px] flex-col justify-between gap-3 px-4 py-4 outline-none sm:flex-row sm:items-center sm:px-5"
                data-approval-composer
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="parallax-approval-icon grid size-9 shrink-0 place-items-center rounded-xl">
                    {visibleApprovalAction.type === 'write' ? <WriteActionIcon /> : <RunActionIcon />}
                  </span>
                  <div className="min-w-0">
                    <div className="parallax-approval-kicker mb-0.5 text-[11px] font-semibold uppercase tracking-[0.08em]">
                      Approval required
                    </div>
                    <div
                      className="parallax-approval-command truncate font-mono text-[13px] font-normal"
                      title={actionLabel}
                    >
                      {actionLabel}
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={onDeny}
                    disabled={approvalLeaving}
                    className="parallax-approval-deny h-8 rounded-lg border px-3 text-[12.5px] font-medium transition-colors"
                  >
                    Deny
                  </button>
                  <button
                    type="button"
                    onClick={onApprove}
                    disabled={approvalLeaving}
                    className="parallax-approval-accept h-8 rounded-lg px-3.5 text-[12.5px] font-semibold shadow-xs transition-[background-color,transform] hover:-translate-y-px"
                  >
                    {approveLabel}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </form>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl">
      {queueSurface}
      <form
        className="w-full min-w-0"
        onSubmit={(e) => {
          e.preventDefault()
          handleSend()
        }}
        onDragEnter={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={(e) => {
          e.preventDefault()
          setDragOver(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          if (e.dataTransfer.files.length > 0) void handleFiles(e.dataTransfer.files)
        }}
      >
      <div className="group rounded-[22px] p-px">
        <div
          className={cn(
            'parallax-composer-shell chat-composer-glass rounded-[20px] border',
            dragOver ? 'border-primary/70 bg-accent/45' : 'border-border',
            'has-[:focus-visible]:border-ring/45',
          )}
        >
          {previewAnnotations.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3 pt-3 sm:px-4">
              {previewAnnotations.map((annotation) => (
                <div
                  key={annotation.id}
                  className="flex max-w-64 items-center gap-2 rounded-xl border border-primary/25 bg-primary/5 py-1.5 pl-1.5 pr-1 text-[11px]"
                >
                  {annotation.screenshot ? (
                    <button
                      type="button"
                      onClick={() =>
                        setPreviewFile({
                          name: `preview-annotation-${annotation.id}.png`,
                          data: annotation.screenshot!.dataUrl,
                          mime: 'image/png',
                        })
                      }
                      className="shrink-0"
                      title="Preview annotated screenshot"
                    >
                      <img
                        src={annotation.screenshot.dataUrl}
                        alt=""
                        className="size-8 rounded-md border border-border object-cover"
                      />
                    </button>
                  ) : (
                    <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-background text-primary">
                      <AnnotationIcon />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-foreground">
                      {annotationLabel(annotation)}
                    </span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {annotation.pageTitle || annotation.pageUrl}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => removePreviewAnnotation(annotation.id)}
                    className="grid size-5 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                    aria-label="Remove preview annotation"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          {/* Attachments */}
          {attachedFiles.length > 0 && (
            <div className={cn('flex flex-wrap gap-2 px-3 sm:px-4', previewAnnotations.length ? 'pt-2' : 'pt-3')}>
              {attachedFiles.map((f, i) => (
                <div
                  key={i}
                  className="relative flex max-w-48 cursor-pointer items-center gap-1.5 rounded-lg border border-border/80 bg-background/70 py-1 pl-2 pr-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent"
                  onClick={() => setPreviewFile(f)}
                >
                  {f.mime.startsWith('image/') ? (
                    <img src={f.data} alt={f.name} className="size-5 rounded object-cover" />
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-muted-foreground/80">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
                    </svg>
                  )}
                  <span className="truncate">{f.name}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      removeFile(i)
                    }}
                    className="grid size-5 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    aria-label={`Remove ${f.name}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Prompt */}
          <div className={cn('relative px-3 sm:px-4', attachedFiles.length || previewAnnotations.length ? 'pt-2' : 'pt-3.5 sm:pt-4')}>
            <textarea
              ref={textareaRef}
              value={text}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              rows={1}
              placeholder={placeholder}
              enterKeyHint="send"
              className="max-h-[160px] min-h-[28px] w-full resize-none bg-transparent pb-2 text-[14px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/35"
            />
          </div>

          {/* Footer toolbar */}
          <div className="flex min-w-0 flex-nowrap items-center justify-between gap-2 px-2.5 pb-2.5 sm:px-3 sm:pb-3">
            <div className="-m-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-visible p-1">
              {/* Model + Intelligence — mirrors ChatGPT's menu: reasoning tiers at
                  the top, current model as a right-flyout submenu of curated models. */}
              <div ref={modelRef} className="relative">
                <button
                  type="button"
                  onClick={() => setModelOpen((v) => !v)}
                  className="flex h-8 items-center gap-1 rounded-lg px-2 text-[12.5px] font-medium text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground/80"
                  title={
                    selectionStatus === 'error'
                      ? 'The selected model or intelligence is not synchronized with ChatGPT'
                      : pickerLabel
                  }
                >
                  <span className="max-w-[150px] truncate whitespace-nowrap text-foreground/80">{pickerLabel}</span>
                  {selectionStatus === 'pending' ? (
                    <span className="whitespace-nowrap text-muted-foreground/45">Syncing…</span>
                  ) : selectionStatus === 'error' ? (
                    <span className="whitespace-nowrap text-destructive/80">Not synced</span>
                  ) : null}
                  <ChevronIcon open={modelOpen} />
                </button>
                {modelOpen && (
                  <div className="absolute bottom-full left-0 z-[1000] mb-1.5 w-max min-w-[150px] max-w-[210px] rounded-xl border border-border bg-popover p-1.5 text-[12.5px] shadow-lg animate-pop-in">
                    {intelligenceOptions.length > 0 && (
                      <>
                        <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
                          Intelligence
                        </div>
                        {intelligenceOptions.map((opt) => (
                          <button
                            key={opt.label}
                            type="button"
                            onClick={() => {
                              onSetIntelligence(opt.label)
                              setModelOpen(false)
                            }}
                            className={cn(
                              'flex w-full items-center gap-3 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-accent',
                              activeIntelligence === opt.label ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground',
                            )}
                          >
                            <span className="flex-1">{opt.label}</span>
                            {opt.hint && <span className="text-muted-foreground/45">{opt.hint}</span>}
                            {activeIntelligence === opt.label && <CheckIcon />}
                          </button>
                        ))}
                        <div className="mx-1 my-1 h-px bg-border" />
                      </>
                    )}

                    {/* Current model → flyout of curated models on hover. */}
                    <div className="group/model relative">
                      <button
                        type="button"
                        className="flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-left text-foreground transition-colors group-hover/model:bg-accent"
                      >
                        <span className="truncate font-medium">{selectedTitle}</span>
                        <ChevronRightIcon />
                      </button>
                      <div className="pointer-events-none absolute bottom-0 left-full z-[1001] hidden pl-1.5 group-hover/model:block group-hover/model:pointer-events-auto">
                        <div className="max-h-[60vh] w-max min-w-[144px] max-w-[210px] overflow-y-auto rounded-xl border border-border bg-popover p-1.5 shadow-lg">
                          {models.map((m) => {
                            const isActive = m.slug === selectedModel?.slug
                            return (
                              <button
                                key={m.slug}
                                type="button"
                                onClick={() => selectModel(m)}
                                className={cn(
                                  'flex w-full items-start justify-between gap-3 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-accent',
                                  isActive ? 'bg-secondary text-foreground' : 'text-muted-foreground',
                                )}
                              >
                                <span className="min-w-0">
                                  <span className={cn('block truncate', isActive && 'font-medium')}>{m.title}</span>
                                  {m.sublabel && (
                                    <span className="block truncate text-[11px] text-muted-foreground/45">{m.sublabel}</span>
                                  )}
                                </span>
                                {isActive && <span className="mt-0.5"><CheckIcon /></span>}
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <span className="mx-0.5 h-4 w-px bg-border max-sm:hidden" />

              {/* Access level */}
              <div ref={permissionRef} className="relative">
                <button
                  type="button"
                  onClick={() => setPermissionOpen((v) => !v)}
                  className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12.5px] font-medium text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground/80"
                  title="Access level for commands and file writes"
                >
                  {/* The trigger wears the ACTIVE level's own icon, so the current
                      access is readable without opening the menu. */}
                  {(() => {
                    const active = permissionOption(permission)
                    return active ? <active.Icon /> : <LockIcon />
                  })()}
                  <span className="whitespace-nowrap">
                    {permissionOption(permission)?.label ?? 'Access'}
                  </span>
                  <ChevronIcon open={permissionOpen} />
                </button>
                {permissionOpen && (
                  <div className="absolute bottom-full left-0 z-[1000] mb-1.5 min-w-[190px] rounded-xl border border-border bg-popover p-1.5 text-[12.5px] shadow-lg animate-pop-in">
                    <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
                      Access
                    </div>
                    {PERMISSION_OPTIONS.map((o) => (
                      <button
                        key={o.id}
                        type="button"
                        onClick={() => {
                          onSetPermission(o.id)
                          setPermissionOpen(false)
                        }}
                        title={o.hint}
                        className={cn(
                          'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-accent',
                          permission === o.id ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground',
                        )}
                      >
                        <span className={cn('shrink-0', permission === o.id ? 'text-foreground' : 'text-muted-foreground/70')}>
                          <o.Icon />
                        </span>
                        <span className="flex-1 whitespace-nowrap">{o.label}</span>
                        {permission === o.id && <CheckIcon />}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <span className="mx-0.5 h-4 w-px bg-border max-sm:hidden" />

              {/* Attach */}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) {
                    void handleFiles(e.target.files)
                    e.target.value = ''
                  }
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12.5px] font-medium text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground/80"
                title="Attach files"
              >
                <PaperclipIcon />
                <span className="hidden sm:inline">Attach</span>
              </button>
            </div>

            {/* The active task can be stopped until a follow-up is ready to queue. */}
            <div className="flex shrink-0 items-center">
              {sending && !canSend ? (
                <button
                  type="button"
                  onClick={() => onStop?.()}
                  className="flex size-8 items-center justify-center rounded-full bg-destructive text-white shadow-xs transition-all duration-150 hover:scale-105 hover:bg-destructive/90"
                  aria-label="Stop generating"
                  title="Stop"
                >
                  <span className="size-2.5 rounded-[3px] bg-white" />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!canSend}
                  className="flex size-8 items-center justify-center rounded-full bg-primary/90 text-primary-foreground shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:shadow-primary/24 hover:scale-105 hover:bg-primary disabled:pointer-events-none disabled:opacity-30 disabled:shadow-none disabled:hover:scale-100"
                  aria-label={queueing ? 'Queue message' : 'Send message'}
                  title={queueing ? 'Queue message' : undefined}
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
                    <path
                      d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* File preview modal */}
      {previewFile && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          onClick={() => setPreviewFile(null)}
        >
          <div
            className="relative max-h-[90vh] max-w-[90vw] overflow-auto rounded-xl border border-border bg-card shadow-2xl animate-pop-in"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setPreviewFile(null)}
              className="absolute right-2 top-2 z-10 grid size-7 place-items-center rounded-md bg-background/80 text-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
            {previewFile.mime.startsWith('image/') ? (
              <img src={previewFile.data} alt={previewFile.name} className="max-h-[85vh] max-w-[85vw] object-contain" />
            ) : previewFile.mime === 'application/pdf' ? (
              <iframe src={previewFile.data} title={previewFile.name} className="h-[85vh] w-[85vw]" />
            ) : previewFile.mime.startsWith('text/') || previewFile.name.match(/\.(txt|md|js|ts|jsx|tsx|css|html|json|xml|yml|yaml|sh|py|rb|go|rs)$/i) ? (
              <pre className="max-h-[80vh] max-w-[80vw] overflow-auto whitespace-pre-wrap break-all p-4 font-mono text-[12px] leading-relaxed text-foreground">
                {atob(previewFile.data.split(',')[1] || '') || 'Binary file'}
              </pre>
            ) : (
              <div className="flex flex-col items-center gap-3 p-8 text-muted-foreground">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                <span className="text-[13px]">{previewFile.name}</span>
                <span className="text-[11px] text-muted-foreground/60">Preview not available for this file type</span>
              </div>
            )}
          </div>
        </div>
      )}
      </form>
    </div>
  )
}

function QueuedMessageList({
  messages,
  onEdit,
  onDelete,
}: {
  messages: QueuedMessage[]
  onEdit?: (messageId: string, text: string) => boolean | void
  onDelete?: (messageId: string) => void
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    if (!editingId || messages.some((message) => message.id === editingId)) return
    setEditingId(null)
    setDraft('')
  }, [editingId, messages])

  if (messages.length === 0) return null

  function beginEdit(message: QueuedMessage) {
    setEditingId(message.id)
    setDraft(message.text)
  }

  function cancelEdit() {
    setEditingId(null)
    setDraft('')
  }

  function saveEdit(messageId: string) {
    const trimmed = draft.trim()
    if (!trimmed || !onEdit) return
    if (onEdit(messageId, trimmed) === false) return
    cancelEdit()
  }

  return (
    <div
      className="mb-1.5 overflow-hidden rounded-[16px] border border-border bg-card shadow-xs"
      aria-label="Queued messages"
      data-queued-message-list
      data-queued-message-count={messages.length}
    >
      {messages.map((message, index) => {
        const editing = editingId === message.id
        const position = index + 1
        return (
          <div
            key={message.id}
            className={cn(
              'flex min-h-11 min-w-0 items-center gap-2.5 px-3.5 py-2',
              index > 0 && 'border-t border-border/70',
            )}
            data-queued-message-row
          >
            <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground/65" aria-hidden>
              <QueuedIcon />
            </span>
            <span className="shrink-0 text-[12px] font-medium text-foreground/85">Queued</span>
            {editing ? (
              <input
                autoFocus
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    saveEdit(message.id)
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    cancelEdit()
                  }
                }}
                className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-[12.5px] text-foreground outline-none focus:border-ring/55"
                aria-label={`Queued message ${position}`}
              />
            ) : (
              <span
                className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground"
                title={message.text}
                data-queued-message-preview
              >
                {message.text}
              </span>
            )}
            <div className="ml-auto flex shrink-0 items-center gap-0.5">
              {editing ? (
                <>
                  <button
                    type="button"
                    onClick={() => saveEdit(message.id)}
                    disabled={!draft.trim()}
                    className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-35"
                    aria-label={`Save queued message ${position}`}
                    title="Save"
                  >
                    <CheckIcon />
                  </button>
                  <button
                    type="button"
                    onClick={cancelEdit}
                    className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    aria-label={`Cancel editing queued message ${position}`}
                    title="Cancel"
                  >
                    <QueuedCancelIcon />
                  </button>
                </>
              ) : (
                <>
                  {onEdit && (
                    <button
                      type="button"
                      onClick={() => beginEdit(message)}
                      className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      aria-label={`Edit queued message ${position}`}
                      title="Edit queued message"
                    >
                      <QueuedEditIcon />
                    </button>
                  )}
                  {onDelete && (
                    <button
                      type="button"
                      onClick={() => onDelete(message.id)}
                      className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                      aria-label={`Delete queued message ${position}`}
                      title="Delete queued message"
                    >
                      <QueuedTrashIcon />
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function OpenAIIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 256 260" fill="currentColor" preserveAspectRatio="xMidYMid" className="text-foreground/90" aria-hidden>
      <path d="M239.184 106.203a64.716 64.716 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.716 64.716 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.665 64.665 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.767 64.767 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483Zm-97.56 136.338a48.397 48.397 0 0 1-31.105-11.255l1.535-.87 51.67-29.825a8.595 8.595 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601Zm-104.466-44.61a48.345 48.345 0 0 1-5.781-32.589l1.534.921 51.722 29.826a8.339 8.339 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803ZM23.549 85.38a48.499 48.499 0 0 1 25.58-21.333v61.39a8.288 8.288 0 0 0 4.195 7.316l62.874 36.272-21.845 12.636a.819.819 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405v.256Zm179.466 41.695-63.08-36.63L161.73 77.86a.819.819 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.544 8.544 0 0 0-4.4-7.213Zm21.742-32.69-1.535-.922-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.716.716 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391v.205ZM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87-51.67 29.825a8.595 8.595 0 0 0-4.246 7.367l-.051 72.697Zm11.868-25.58 28.138-16.217 28.188 16.218v32.434l-28.086 16.218-28.188-16.218-.052-32.434Z" />
    </svg>
  )
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('text-muted-foreground/60 transition-transform', open && 'rotate-180')}
      aria-hidden
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-primary" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

function ChevronRightIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 shrink-0 text-muted-foreground/45" aria-hidden>
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

function PaperclipIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  )
}

function AnnotationIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m4 4 7.5 16 2.1-6.4L20 11.5 4 4Z" />
      <path d="m13.6 13.6 4.4 4.4" />
    </svg>
  )
}

function QueuedIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  )
}

function QueuedEditIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  )
}

function QueuedCancelIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  )
}

function QueuedTrashIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  )
}

function RunActionIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m5 7 5 5-5 5" />
      <path d="M12 17h7" />
    </svg>
  )
}

function WriteActionIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.4 2.6a1 1 0 0 1 3 3l-9 9-3.9 1 1-3.9z" />
    </svg>
  )
}

function LockIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  )
}
