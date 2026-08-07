import { cn } from '../lib/utils'

// A slim status bar for just above the composer — Codex-style. `warning` is amber
// with a live "still trying" pulse; `error` is red with an alert glyph.
export default function ComposerBanner({
  tone,
  title,
  detail,
}: {
  tone: 'warning' | 'error'
  title: string
  detail?: string
}) {
  const warn = tone === 'warning'
  // The icon sits on the TITLE'S OWN LINE (a flex row of exactly that line's
  // height) rather than floating in the banner's top-left. Aligning it against the
  // whole block left it visibly riding high above the text. The detail paragraph is
  // indented by icon + gap so it lines up under the title.
  return (
    <div
      className={cn(
        'rounded-xl border px-3 py-2 animate-fade-in',
        warn
          ? 'border-amber-500/35 bg-amber-400/[0.14] dark:border-amber-400/25 dark:bg-amber-400/[0.1]'
          : 'border-destructive/30 bg-destructive/[0.1]',
      )}
      role={warn ? 'status' : 'alert'}
    >
      <div className="flex items-center gap-2">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className={cn('size-3.5 shrink-0', warn ? 'text-amber-600 dark:text-amber-400' : 'text-destructive')}
        >
          <circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" />
        </svg>
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[12px] font-semibold leading-4',
            warn ? 'text-amber-800 dark:text-amber-200' : 'text-destructive',
          )}
        >
          {title}
        </span>
      </div>
      {detail && (
        <p
          className={cn(
            'mt-1 ps-[22px] text-[11.5px] leading-snug',
            warn ? 'text-amber-700/90 dark:text-amber-200/70' : 'text-muted-foreground/85',
          )}
        >
          {detail}
        </p>
      )}
    </div>
  )
}
