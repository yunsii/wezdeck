import { cn } from '#/lib/utils'

export type LedTone = 'running' | 'waiting' | 'done' | 'error' | 'muted'

const color: Record<LedTone, string> = {
  running: 'text-brand-running',
  waiting: 'text-brand-waiting',
  done: 'text-brand-done',
  error: 'text-brand-error',
  muted: 'text-brand-label',
}

/**
 * Status light in the app icon's vocabulary: ● running, ▲ waiting,
 * ✓ done, ✕ failed, ○ idle. Shape carries the meaning, color reinforces it.
 */
export function Led({
  tone,
  size = 12,
  className,
  label,
}: {
  tone: LedTone
  size?: number
  className?: string
  label?: string
}) {
  const shape = {
    running: <circle cx="6" cy="6" r="4.5" fill="currentColor" />,
    waiting: <path d="M6 1.2 11 10.5H1Z" fill="currentColor" />,
    done: (
      <path
        d="M1.8 6.4 4.6 9.2 10.4 2.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
    error: (
      <path
        d="M2.5 2.5 9.5 9.5M9.5 2.5 2.5 9.5"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    ),
    muted: (
      <circle
        cx="6"
        cy="6"
        r="3.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
    ),
  }[tone]
  return (
    <svg
      viewBox="0 0 12 12"
      width={size}
      height={size}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn(
        'shrink-0',
        color[tone],
        tone === 'running' && 'led-running',
        className,
      )}
    >
      {shape}
    </svg>
  )
}
