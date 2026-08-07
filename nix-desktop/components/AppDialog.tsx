import { useEffect, useRef } from 'react'
import { cn } from '../lib/utils'

interface Props {
  open: boolean
  title: string
  description?: React.ReactNode
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
  destructive?: boolean
  confirmDisabled?: boolean
  initialFocus?: 'cancel' | 'confirm' | false
  children?: React.ReactNode
}

export default function AppDialog({
  open,
  title,
  description,
  confirmLabel,
  onConfirm,
  onCancel,
  destructive,
  confirmDisabled,
  initialFocus = 'cancel',
  children,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    const timer = window.setTimeout(() => {
      if (initialFocus === 'cancel') cancelRef.current?.focus()
      if (initialFocus === 'confirm') confirmRef.current?.focus()
    }, 0)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [initialFocus, onCancel, open])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div
        role={destructive ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby="nix-dialog-title"
        aria-describedby={description ? 'nix-dialog-description' : undefined}
        className="w-full max-w-sm rounded-2xl border border-border bg-card p-4 text-card-foreground shadow-2xl animate-pop-in"
      >
        <h2 id="nix-dialog-title" className="text-[14px] font-semibold leading-5 text-foreground">
          {title}
        </h2>
        {description && (
          <div
            id="nix-dialog-description"
            className="mt-1.5 text-[12.5px] leading-5 text-muted-foreground"
          >
            {description}
          </div>
        )}
        {children && <div className="mt-3">{children}</div>}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="h-8 rounded-lg border border-border bg-background px-3 text-[12.5px] font-medium text-foreground transition-colors hover:bg-accent"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            disabled={confirmDisabled}
            onClick={onConfirm}
            className={cn(
              'h-8 rounded-lg px-3 text-[12.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
              destructive
                ? 'bg-destructive text-white hover:bg-destructive/90'
                : 'bg-primary text-primary-foreground hover:bg-primary/90',
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
