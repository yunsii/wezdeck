// Top of a session page, pinned while the thread scrolls under it: back,
// which session this is, and three meters — context used,
// the Claude account's 5-hour and 7-day limits (reported by Claude Code to
// its status line, scripts/runtime/claude-statusline-tap.sh). Tapping the
// meters shows the spend (model, output, cache hit), how fresh the limits
// are. The header's height is shared
// as --session-head so the sticky prompt (chat-sticky.tsx) sits under it.
import { useLingui } from '@lingui/react/macro'
import { ChevronDown, Info } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { BackButton } from '#/components/deck/back-button'

import { cn } from '#/lib/utils'
import type { Detail } from './console-sessions'
import { useAgo } from './tickets-view'
import { SessionInfo } from './session-info'
import {
  NEAR_FULL,
  usageMetrics,
  usagePercent,
  useUsageLabel,
} from './session-usage'
import {
  SessionSwitcher,
  useSessionKeys,
  useSessionNav,
} from './session-switcher'
import { Button } from '#/components/ui/button'

const tokens = (n: number) =>
  n >= 10_000 ? `${(n / 10_000).toFixed(n >= 100_000 ? 0 : 1)} 万` : String(n)

const isoOf = (unixSeconds?: number) =>
  unixSeconds ? new Date(unixSeconds * 1000).toISOString() : undefined

/** One meter: the label, how much is used, and a fill behind it. */
function Meter({
  label,
  percent,
  note,
}: {
  label: string
  percent: number
  note?: string
}) {
  const used = usagePercent(percent)
  const fill =
    used >= 90
      ? 'bg-brand-error'
      : used >= 75
        ? 'bg-brand-waiting'
        : 'bg-brand-running'
  return (
    <span className="relative inline-flex h-6 shrink-0 items-center gap-1 overflow-hidden rounded-full bg-brand-surface px-2 text-meta text-brand-muted">
      <span
        aria-hidden
        className={cn('absolute inset-y-0 left-0 opacity-20', fill)}
        style={{ width: `${used}%` }}
      />
      <span className="relative">{label}</span>
      <span className="relative font-semibold text-brand-text">{used}%</span>
      {note ? <span className="relative text-brand-label">{note}</span> : null}
    </span>
  )
}

export function SessionUsageAlerts({
  data,
  visibleUsage,
}: {
  data?: Detail
  visibleUsage?: string
}) {
  const { t } = useLingui()
  const label = useUsageLabel()
  const ago = useAgo()
  const [open, setOpen] = useState(false)
  const { usage, account } = data ?? {}
  const visible = visibleUsage?.split(' ')
  const alerts = usageMetrics(usage, account).filter(
    (metric) => metric.percent >= NEAR_FULL && !visible?.includes(metric.id),
  )
  if (!alerts.length) return null
  const usedTokens = tokens(usage?.context ?? 0)
  const limitTokens = tokens(usage?.context_limit ?? 0)
  const outputTokens = tokens(usage?.output ?? 0)
  const limitsAt = ago(isoOf(account?.at))
  const hit =
    usage && usage.input + usage.cache_read
      ? Math.round((usage.cache_read / (usage.input + usage.cache_read)) * 100)
      : 0
  return (
    <div className="grid gap-1">
      <Button
        variant="plain"
        type="button"
        data-testid="session-usage"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex min-w-0 flex-wrap items-center gap-1.5 text-left"
      >
        {alerts.map((metric) => {
          const reset = ago(isoOf(metric.resetsAt))
          return (
            <Meter
              key={metric.id}
              label={label(metric.id)}
              percent={metric.percent}
              note={reset ? t`resets ${reset}` : undefined}
            />
          )
        })}
      </Button>
      {open ? (
        <p className="flex flex-wrap gap-x-3 px-1 text-meta text-brand-label">
          {usage?.model ? <span>{usage.model}</span> : null}
          {usage?.context_limit ? (
            <span>{t`Context ${usedTokens} / ${limitTokens}`}</span>
          ) : null}
          {usage ? <span>{t`output ${outputTokens}`}</span> : null}
          {usage ? <span>{t`cache hit ${hit}%`}</span> : null}
          {account ? <span>{t`limits as of ${limitsAt}`}</span> : null}
        </p>
      ) : null}
    </div>
  )
}

export function SessionHeader({
  id,
  data,
  onBack,
  onRename,
  renameDisabled,
  visibleUsage,
}: {
  id: string
  data: Detail | undefined
  onBack: () => void
  /** Paste `/rename <title>` into the agent TUI (Claude and Grok both honor it). */
  onRename?: (title: string) => void
  visibleUsage?: string
  renameDisabled?: boolean
}) {
  const { t } = useLingui()
  const [infoOpen, setInfoOpen] = useState(false)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const openSwitcher = useCallback(() => setSwitcherOpen(true), [])
  const nav = useSessionNav(id)
  useSessionKeys(nav.jump, openSwitcher)
  const head = useRef<HTMLElement>(null)
  useEffect(() => {
    const el = head.current
    const page = document.getElementById('console-main')
    if (!el || !page || typeof ResizeObserver === 'undefined') return
    const root = document.documentElement
    const observer = new ResizeObserver(() => {
      page.style.setProperty('--session-head', `${el.offsetHeight}px`)
      // toasts drop in under this bar, not over its back button (pwa-boot)
      root.style.setProperty(
        '--toast-top',
        `${Math.round(el.getBoundingClientRect().bottom)}px`,
      )
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      page.style.removeProperty('--session-head')
      root.style.removeProperty('--toast-top')
    }
  }, [])
  const title = data ? data.title || t`Untitled session` : ''
  return (
    // opaque: at 95 % a dark user bubble scrolling under it greyed the
    // header (and an image's loading pulse flickered through)
    <header
      ref={head}
      data-testid="session-header"
      className="sticky top-[env(safe-area-inset-top)] z-30 -mx-2.5 -mt-1 grid gap-1.5 border-b border-brand-edge bg-brand-deck px-2.5 pt-1 pb-2 md:-ml-2.5 md:mr-0 md:mt-0"
    >
      <div className="flex min-w-0 items-center gap-1">
        {/* the list sits beside the conversation on a wide screen */}
        <BackButton
          onClick={onBack}
          label={t({ message: 'Sessions', context: 'nav' })}
          className="-ml-2 md:hidden"
        />
        <div className="grid min-w-0 flex-1">
          {/* Alt+g / Alt+x at the desk: pick another session */}
          <Button
            variant="plain"
            type="button"
            onClick={openSwitcher}
            aria-haspopup="dialog"
            data-testid="session-title"
            data-session-id={data?.id}
            title={t`Switch session (Alt+g)`}
            className="flex min-w-0 items-center gap-1 text-left text-title leading-tight font-semibold"
          >
            <span
              className={cn(
                'truncate',
                data && !data.title && 'text-brand-label',
              )}
            >
              {title || t`Loading…`}
            </span>
            <ChevronDown
              size={15}
              aria-hidden
              className="shrink-0 text-brand-label"
            />
          </Button>
          {/* agent, branch, git, node, worktrees and background tasks
              live in the status bar under the composer (session-statusbar) */}
        </div>
        {data ? (
          <Button
            variant="plain"
            type="button"
            onClick={() => setInfoOpen(true)}
            aria-label={t`Session info`}
            aria-haspopup="dialog"
            data-testid="session-info-button"
            className="-mr-1 inline-flex size-10 shrink-0 items-center justify-center rounded-full text-brand-muted"
          >
            <Info size={19} aria-hidden />
          </Button>
        ) : null}
      </div>
      <SessionUsageAlerts data={data} visibleUsage={visibleUsage} />
      {data ? (
        <SessionInfo
          data={data}
          open={infoOpen}
          onClose={() => setInfoOpen(false)}
          onRename={onRename}
          renameDisabled={renameDisabled}
        />
      ) : null}
      <SessionSwitcher
        current={id}
        open={switcherOpen}
        onClose={() => setSwitcherOpen(false)}
      />
    </header>
  )
}
