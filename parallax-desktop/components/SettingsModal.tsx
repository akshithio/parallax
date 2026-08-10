import { useEffect, useState } from 'react'
import type { Conversation, PermissionLevel } from '../hooks/useParallax'
import { cn, folderName } from '../lib/utils'
import AppDialog from './AppDialog'
import { PERMISSION_OPTIONS } from './permissions'

interface StatusInfo {
  status: string
  detail: string
}

export type AppIconPreference = 'system' | 'light' | 'dark'

export const APP_ICON_OPTIONS: { id: AppIconPreference; label: string }[] = [
  { id: 'system', label: 'Match system' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
]

export interface UpdateStatus {
  status: 'disabled' | 'idle' | 'checking' | 'downloading' | 'downloaded' | 'installing' | 'up-to-date' | 'error'
  currentVersion: string
  availableVersion: string
  progress: number | null
  message: string
}

interface Props {
  open: boolean
  onClose: () => void
  permission: PermissionLevel
  onSetPermission: (v: PermissionLevel) => void
  serverStatus: StatusInfo
  wsStatus: StatusInfo
  chatgptStatus: StatusInfo
  conversations: Record<string, Conversation>
  convOrder: string[]
  onUnarchive: (ids: string[]) => void
  onDeleteAll: () => void
  updateStatus?: UpdateStatus
  onCheckForUpdates?: () => void
  onInstallUpdate?: () => void
}

export default function SettingsModal({
  open,
  onClose,
  permission,
  onSetPermission,
  serverStatus,
  wsStatus,
  chatgptStatus,
  conversations,
  convOrder,
  onUnarchive,
  onDeleteAll,
  updateStatus = {
    status: 'disabled',
    currentVersion: '',
    availableVersion: '',
    progress: null,
    message: 'Update checks are available in installed builds.',
  },
  onCheckForUpdates,
  onInstallUpdate,
}: Props) {
  const [dark, setDark] = useState(true)
  const [appIcon, setAppIcon] = useState<AppIconPreference>('system')
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false)

  useEffect(() => {
    if (typeof document !== 'undefined') setDark(document.documentElement.classList.contains('dark'))
  }, [open])

  // The dock icon lives in the main process, so restore the saved choice on
  // mount rather than waiting for the user to open Settings.
  useEffect(() => {
    let saved: string | null = null
    try { saved = localStorage.getItem('parallax:appIcon') } catch {}
    const preference = APP_ICON_OPTIONS.some(o => o.id === saved)
      ? (saved as AppIconPreference)
      : 'system'
    setAppIcon(preference)
    window.parallax?.setDockIcon?.(preference)
  }, [])

  useEffect(() => {
    if (!open) setConfirmDeleteAll(false)
  }, [open])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !confirmDeleteAll) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirmDeleteAll, open, onClose])

  function applyTheme(next: boolean) {
    setDark(next)
    document.documentElement.classList.toggle('dark', next)
    try { localStorage.setItem('parallax:theme', next ? 'dark' : 'light') } catch {}
  }

  function applyAppIcon(next: AppIconPreference) {
    setAppIcon(next)
    try { localStorage.setItem('parallax:appIcon', next) } catch {}
    window.parallax?.setDockIcon?.(next)
  }

  if (!open) return null
  const archived = convOrder
    .map(id => conversations[id])
    .filter((conversation): conversation is Conversation => Boolean(conversation?.archived))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))

  return (
    <>
      <div
        className="fixed inset-0 z-[9999] flex items-start justify-center overflow-y-auto bg-black/50 p-4 pt-[8vh] backdrop-blur-sm"
        onClick={onClose}
      >
        <div
          className="w-full max-w-lg rounded-2xl border border-border bg-card shadow-2xl animate-pop-in"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
            <h2 className="text-sm font-semibold text-foreground">Settings</h2>
            <button
              type="button"
              onClick={onClose}
              className="grid size-7 place-items-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
              aria-label="Close settings"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          </div>

          <div className="max-h-[70vh] space-y-6 overflow-y-auto px-5 py-5">
          {/* Appearance */}
          <Section title="Appearance">
            <div className="grid grid-cols-2 gap-2">
              <ThemeCard label="Light" active={!dark} onClick={() => applyTheme(false)} scheme="light" />
              <ThemeCard label="Dark" active={dark} onClick={() => applyTheme(true)} scheme="dark" />
            </div>
          </Section>

          {/* App icon */}
          <Section title="App icon" subtitle="Which plate the dock tile uses.">
            <div className="grid grid-cols-3 gap-2">
              {APP_ICON_OPTIONS.map((option) => (
                <AppIconCard
                  key={option.id}
                  label={option.label}
                  active={appIcon === option.id}
                  onClick={() => applyAppIcon(option.id)}
                  scheme={option.id === 'system' ? (dark ? 'dark' : 'light') : option.id}
                />
              ))}
            </div>
          </Section>

          {/* Access level */}
          <Section title="Access level" subtitle="How much the agent can do on its own.">
            <div className="space-y-1.5">
              {PERMISSION_OPTIONS.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => onSetPermission(o.id)}
                  className={cn(
                    'flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
                    permission === o.id ? 'border-primary/60 bg-primary/8' : 'border-border/70 hover:bg-accent/50',
                  )}
                >
                  <span
                    className={cn(
                      'mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border',
                      permission === o.id ? 'border-primary' : 'border-border',
                    )}
                  >
                    {permission === o.id && <span className="size-2 rounded-full bg-primary" />}
                  </span>
                  <span
                    className={cn(
                      'mt-px shrink-0',
                      permission === o.id ? 'text-primary' : 'text-muted-foreground/70',
                    )}
                  >
                    <o.Icon size={15} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium text-foreground">{o.label}</span>
                    <span className="block text-[11.5px] text-muted-foreground/75">{o.longHint}</span>
                  </span>
                </button>
              ))}
            </div>
          </Section>

          {/* Connection */}
          <Section title="Connection" subtitle="Live status of the bridge to ChatGPT.">
            <div className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70">
              <StatusRow label="Local server" info={serverStatus} okWhen={['listening']} />
              <StatusRow label="Extension" info={wsStatus} okWhen={['connected']} />
              <StatusRow label="ChatGPT tab" info={chatgptStatus} okWhen={['ready']} />
            </div>
          </Section>

          <Section
            title="Updates"
            subtitle="Installed builds check GitHub Releases automatically."
          >
            <UpdateControls
              info={updateStatus}
              onCheck={onCheckForUpdates}
              onInstall={onInstallUpdate}
            />
          </Section>

          <Section
            title="Archived chats"
            subtitle="Archived chats stay out of the sidebar and search until you restore them."
          >
            {archived.length > 0 ? (
              <div className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70">
                {archived.map((conversation) => (
                  <div
                    key={conversation.id}
                    className="flex items-center gap-3 px-3 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12.5px] font-medium text-foreground">
                        {conversation.title || 'Untitled chat'}
                      </div>
                      {conversation.folderPath && (
                        <div className="mt-0.5 truncate text-[11px] text-muted-foreground/65">
                          {folderName(conversation.folderPath)}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => onUnarchive([conversation.id])}
                      className="h-7 shrink-0 rounded-md border border-border/70 px-2.5 text-[11.5px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      aria-label={`Restore ${conversation.title || 'Untitled chat'}`}
                    >
                      Restore
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border/70 px-3 py-3 text-[12px] text-muted-foreground/65">
                No archived chats
              </div>
            )}
          </Section>

          {/* Danger zone */}
          <Section title="Data">
            <button
              type="button"
              onClick={() => setConfirmDeleteAll(true)}
              className="flex w-full items-center justify-between rounded-lg border border-destructive/30 px-3 py-2.5 text-left text-[13px] font-medium text-destructive transition-colors hover:bg-destructive/10"
            >
              <span>Delete all conversations</span>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
            </button>
          </Section>
          </div>
        </div>
      </div>

      <AppDialog
        open={confirmDeleteAll}
        destructive
        title="Delete all conversations?"
        description="This permanently removes every conversation. Projects remain available."
        confirmLabel="Delete all"
        onCancel={() => setConfirmDeleteAll(false)}
        onConfirm={() => {
          onDeleteAll()
          setConfirmDeleteAll(false)
          onClose()
        }}
      />
    </>
  )
}

function UpdateControls({
  info,
  onCheck,
  onInstall,
}: {
  info: UpdateStatus
  onCheck?: () => void
  onInstall?: () => void
}) {
  const busy = ['checking', 'downloading', 'installing'].includes(info.status)
  const ready = info.status === 'downloaded'
  const disabled = info.status === 'disabled'
  const label = ready
    ? 'Restart to update'
    : info.status === 'checking'
      ? 'Checking…'
      : info.status === 'downloading'
        ? 'Downloading…'
        : info.status === 'installing'
          ? 'Restarting…'
          : 'Check for updates'
  const dotClass =
    info.status === 'error'
      ? 'bg-destructive'
      : ready
        ? 'bg-success'
        : busy
          ? 'bg-amber-500'
          : 'bg-muted-foreground/45'

  return (
    <div className="rounded-lg border border-border/70 px-3 py-3" aria-live="polite">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={cn('size-1.5 shrink-0 rounded-full', dotClass, busy && 'animate-pulse')} />
            <span className="text-[12.5px] font-medium text-foreground">
              {info.currentVersion ? `Parallax ${info.currentVersion}` : 'Parallax'}
            </span>
          </div>
          <p className={cn('mt-1 text-[11.5px]', info.status === 'error' ? 'text-destructive' : 'text-muted-foreground/70')}>
            {info.message}
          </p>
          {info.status === 'downloading' && info.progress !== null && (
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
                style={{ width: `${Math.max(0, Math.min(100, info.progress))}%` }}
              />
            </div>
          )}
        </div>
        <button
          type="button"
          disabled={busy || disabled}
          onClick={ready ? onInstall : onCheck}
          className="h-7 shrink-0 rounded-md border border-border/70 px-2.5 text-[11.5px] font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-default disabled:opacity-45"
        >
          {label}
        </button>
      </div>
    </div>
  )
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">{title}</h3>
        {subtitle && <p className="mt-0.5 text-[11.5px] text-muted-foreground/60">{subtitle}</p>}
      </div>
      {children}
    </section>
  )
}

function ThemeCard({ label, active, onClick, scheme }: { label: string; active: boolean; onClick: () => void; scheme: 'light' | 'dark' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex flex-col gap-2 rounded-lg border p-2.5 text-left transition-colors',
        active ? 'border-primary/60 bg-primary/8' : 'border-border/70 hover:bg-accent/50',
      )}
    >
      <div className={cn('h-12 w-full overflow-hidden rounded-md border', scheme === 'dark' ? 'border-white/10 bg-[#1a1a1a]' : 'border-black/10 bg-[#f5f5f5]')}>
        <div className={cn('h-2 w-full', scheme === 'dark' ? 'bg-white/10' : 'bg-black/10')} />
        <div className="space-y-1 p-1.5">
          <div className={cn('h-1.5 w-3/4 rounded-full', scheme === 'dark' ? 'bg-white/20' : 'bg-black/15')} />
          <div className={cn('h-1.5 w-1/2 rounded-full', scheme === 'dark' ? 'bg-white/12' : 'bg-black/10')} />
        </div>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[12.5px] font-medium text-foreground">{label}</span>
        {active && (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-primary"><path d="M20 6 9 17l-5-5" /></svg>
        )}
      </div>
    </button>
  )
}

function AppIconCard(
  { label, active, onClick, scheme }:
  { label: string; active: boolean; onClick: () => void; scheme: 'light' | 'dark' },
) {
  const plate = scheme === 'dark' ? '#16161a' : '#fbfbf9'
  const ink = scheme === 'dark' ? '#fbfbf9' : '#16161a'
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex flex-col items-center gap-2 rounded-lg border p-2.5 transition-colors',
        active ? 'border-primary/60 bg-primary/8' : 'border-border/70 hover:bg-accent/50',
      )}
    >
      <svg viewBox="0 0 64 64" className="size-11" aria-hidden="true">
        <rect width="64" height="64" rx="14" fill={plate} />
        <g fill="none" stroke={ink} strokeLinecap="round">
          <path d="M32 12v40" strokeWidth="5" opacity="0.36" />
          <path d="M17 17 32 32 47 32" strokeWidth="7" />
          <path d="M32 32 47 47" strokeWidth="7" opacity="0.32" />
        </g>
      </svg>
      <span className="flex items-center gap-1 text-[12px] font-medium text-foreground">
        {label}
        {active && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-primary"><path d="M20 6 9 17l-5-5" /></svg>
        )}
      </span>
    </button>
  )
}

function StatusRow({ label, info, okWhen }: { label: string; info: StatusInfo; okWhen: string[] }) {
  const ok = okWhen.includes(info.status)
  const bad = info.status === 'error' || info.status === 'disconnected'
  return (
    <div className="flex items-center justify-between px-3 py-2 text-[12.5px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1.5">
        <span className={cn('size-1.5 rounded-full', ok ? 'bg-success' : bad ? 'bg-destructive' : 'bg-amber-500')} />
        <span className={cn('font-medium', ok ? 'text-foreground/80' : bad ? 'text-destructive' : 'text-muted-foreground')}>
          {info.status || 'waiting'}
        </span>
      </span>
    </div>
  )
}
