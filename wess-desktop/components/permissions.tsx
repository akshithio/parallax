import type { PermissionLevel } from '../hooks/useWess'

// The three access levels, defined once and shared by the composer control and
// Settings so their labels, hints, and icons can never drift apart.
//
// Each level gets its OWN icon — one shared padlock made the menu read as a single
// state with three captions. The silhouettes are deliberately unalike so the
// current level is legible at 13px in the composer:
//   eye    → inspect automatically, escalate changes
//   shield → guarded, every action is signed off by hand
//   bolt   → runs unattended
//
// `approve` keeps its id (it's persisted) but is labelled "Manual": the level is
// about WHO drives each action, not about a one-off approval.

function EyeIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function ShieldIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 22s8-3.6 8-10V5.5l-8-3-8 3V12c0 6.4 8 10 8 10Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  )
}

function BoltIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12L13 2Z" />
    </svg>
  )
}

export interface PermissionOption {
  id: PermissionLevel
  label: string
  /** Short hint for the composer menu (tight on width). */
  hint: string
  /** Fuller sentence for Settings, which has room. */
  longHint: string
  Icon: (props: { size?: number }) => JSX.Element
}

export const PERMISSION_OPTIONS: PermissionOption[] = [
  {
    id: 'auto-review',
    label: 'Auto-review',
    hint: 'Run routine actions; ask when flagged',
    longHint: 'Run routine actions automatically and ask when review is needed',
    Icon: EyeIcon,
  },
  {
    id: 'approve',
    label: 'Manual',
    hint: 'Ask before any command or file write',
    longHint: 'Ask before running any command or writing a file',
    Icon: ShieldIcon,
  },
  {
    id: 'full-access',
    label: 'Full access',
    hint: 'Run commands & write files unattended',
    longHint: 'Run commands and write files without asking',
    Icon: BoltIcon,
  },
]

export function permissionOption(id: PermissionLevel): PermissionOption | undefined {
  return PERMISSION_OPTIONS.find((o) => o.id === id)
}
