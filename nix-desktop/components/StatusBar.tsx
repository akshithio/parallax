interface Props {
  serverStatus: { status: string; detail: string }
  wsStatus: { status: string; detail: string }
  chatgptStatus: { status: string; detail: string }
  onDebug?: () => void
}

/** Compact connection pills — kept for optional use; primary status lives in the sidebar. */
export default function StatusBar({ serverStatus, wsStatus, chatgptStatus, onDebug }: Props) {
  const items = [
    {
      ok: serverStatus.status === 'listening',
      warn: false,
      label:
        serverStatus.status === 'listening'
          ? `server :${serverStatus.detail || '8765'}`
          : `server ${serverStatus.status}`,
    },
    {
      ok: wsStatus.status === 'connected',
      warn: false,
      label: `ext ${wsStatus.status}`,
    },
    {
      ok: chatgptStatus.status === 'ready',
      warn: chatgptStatus.status === 'navigating',
      label: `chatgpt ${chatgptStatus.status}`,
    },
  ]

  return (
    <div className="flex max-w-full flex-wrap items-center justify-center gap-2 rounded-full border border-border/60 bg-card/40 px-3 py-1.5 text-[11px] font-medium leading-tight text-muted-foreground backdrop-blur-sm">
      {items.map((item) => (
        <span key={item.label} className="flex items-center gap-1.5 whitespace-nowrap">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              item.ok
                ? 'bg-success'
                : item.warn
                  ? 'bg-warning'
                  : item.label.includes('waiting')
                    ? 'bg-muted-foreground/40'
                    : 'bg-destructive'
            }`}
          />
          {item.label}
        </span>
      ))}
      {onDebug && (
        <>
          <span className="h-3 w-px bg-border max-sm:hidden" />
          <button
            onClick={onDebug}
            className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70 transition-colors hover:text-foreground"
          >
            debug
          </button>
        </>
      )}
    </div>
  )
}
