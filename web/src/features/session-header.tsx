// Top of a session page, pinned while the thread scrolls under it: back,
// which session this is, its status, and three meters — context used,
// the Claude account's 5-hour and 7-day limits (reported by Claude Code to
// its status line, scripts/runtime/claude-statusline-tap.sh). Tapping the
// meters shows the spend (model, output, cache hit), how fresh the limits
// are, and the background tasks (counted in the meter row). The header's height is shared
// as --session-head so the sticky prompt (chat-sticky.tsx) sits under it.
import { useLingui } from '@lingui/react/macro'
import { ChevronLeft } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Led } from '#/components/deck/led'
import { cn } from '#/lib/utils'
import { sessionTone, useStatusText } from './console-sessions'
import type { AccountLimits, BgTask, Detail, Usage } from './console-sessions'
import { useAgo } from './tickets-view'

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
  const used = Math.max(0, Math.min(100, Math.round(percent)))
  const fill =
    used >= 90
      ? 'bg-brand-error'
      : used >= 75
        ? 'bg-brand-waiting'
        : 'bg-brand-running'
  return (
    <span className="relative inline-flex h-6 shrink-0 items-center gap-1 overflow-hidden rounded-full bg-brand-surface px-2 text-[11.5px] text-brand-muted">
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

function Meters({
  usage,
  account,
  background,
}: {
  usage?: Usage
  account?: AccountLimits
  background: Array<BgTask>
}) {
  const { t } = useLingui()
  const ago = useAgo()
  const [open, setOpen] = useState(false)
  const context =
    usage?.context_limit && usage.context
      ? (usage.context / usage.context_limit) * 100
      : null
  if (context === null && !account && !background.length) return null
  const five = account?.five_hour
  const week = account?.seven_day
  const fiveReset = ago(isoOf(five?.resets_at))
  const weekReset = ago(isoOf(week?.resets_at))
  const tasks = background.length
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
      <button
        type="button"
        data-testid="session-usage"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex min-w-0 flex-wrap items-center gap-1.5 text-left"
      >
        {context !== null ? (
          <Meter label={t`Context`} percent={context} />
        ) : null}
        {five ? (
          <Meter
            label={t`5 h`}
            percent={five.used_percentage}
            note={fiveReset ? t`resets ${fiveReset}` : undefined}
          />
        ) : null}
        {week ? (
          <Meter
            label={t`7 d`}
            percent={week.used_percentage}
            note={weekReset ? t`resets ${weekReset}` : undefined}
          />
        ) : null}
        {background.length ? (
          <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-brand-surface px-2 text-[11.5px] text-brand-muted">
            <Led tone="running" size={8} className="led-running" />
            {t`${tasks} background tasks`}
          </span>
        ) : null}
      </button>
      {open ? (
        <p className="flex flex-wrap gap-x-3 px-1 text-[11px] text-brand-label">
          {usage?.model ? <span>{usage.model}</span> : null}
          {usage?.context_limit ? (
            <span>{t`Context ${usedTokens} / ${limitTokens}`}</span>
          ) : null}
          {usage ? <span>{t`output ${outputTokens}`}</span> : null}
          {usage ? <span>{t`cache hit ${hit}%`}</span> : null}
          {account ? <span>{t`limits as of ${limitsAt}`}</span> : null}
        </p>
      ) : null}
      {open && background.length ? (
        <ul
          aria-label={t`Background tasks`}
          className="grid gap-1 rounded-[12px] bg-brand-surface px-3 py-2"
        >
          {background.map((task) => (
            <li
              key={task.id}
              className="flex items-center gap-2 truncate font-mono text-[12px] text-brand-muted"
            >
              <Led tone="running" size={9} />
              {task.summary || task.id}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export function SessionHeader({
  data,
  onBack,
  onRename,
  renameDisabled,
}: {
  data: Detail | undefined
  onBack: () => void
  /** Paste `/rename <title>` into the agent TUI (Claude and Grok both honor it). */
  onRename?: (title: string) => void
  renameDisabled?: boolean
}) {
  const { t } = useLingui()
  const statusText = useStatusText()
  const tone = sessionTone(data?.status ?? '', data?.waiting_kind)
  const head = useRef<HTMLElement>(null)
  useEffect(() => {
    const el = head.current
    const page = document.getElementById('console-main')
    if (!el || !page || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      page.style.setProperty('--session-head', `${el.offsetHeight}px`)
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      page.style.removeProperty('--session-head')
    }
  }, [])
  const title =
    data?.title || data?.name || data?.window || data?.id.slice(0, 8) || ''
  // a word next to the light; the full sentence is the tooltip (background
  // tasks have their own meter)
  const short = data?.waiting_kind
    ? t`Needs you`
    : data?.status === 'running' && data.running_kind !== 'background'
      ? t`Running`
      : data?.status === 'idle'
        ? t`Idle`
        : t`Turn over`
  const long = data
    ? statusText(
        data.status,
        data.waiting_kind,
        data.running_kind,
        data.background?.length ?? 0,
      )
    : undefined
  const rename = () => {
    if (!onRename || renameDisabled) return
    const next = window.prompt(t`New session title`, title)
    const trimmed = next?.trim()
    if (!trimmed || trimmed === title) return
    onRename(trimmed)
  }
  return (
    <header
      ref={head}
      data-testid="session-header"
      className="sticky top-[env(safe-area-inset-top)] z-30 -mx-2.5 -mt-1 grid gap-1.5 border-b border-brand-edge bg-brand-deck/95 px-2.5 pt-1 pb-2 backdrop-blur"
    >
      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          onClick={onBack}
          aria-label={t({ message: 'Sessions', context: 'nav' })}
          className="-ml-2 inline-flex size-11 shrink-0 items-center justify-center text-brand-muted"
        >
          <ChevronLeft size={22} aria-hidden />
        </button>
        <div className="grid min-w-0 flex-1">
          <button
            type="button"
            disabled={!onRename || renameDisabled}
            onClick={rename}
            title={
              onRename ? t`Rename via /rename in the agent pane` : undefined
            }
            className="truncate text-left text-[16px] leading-tight font-semibold disabled:opacity-100"
          >
            {title || t`Loading…`}
          </button>
          {data?.branch ? (
            <span className="truncate font-mono text-[11.5px] text-brand-label">
              {data.branch}
            </span>
          ) : null}
        </div>
        <span
          title={long}
          className="inline-flex shrink-0 items-center gap-1.5 text-[12.5px] text-brand-muted"
        >
          <Led tone={tone} size={10} />
          {data ? short : null}
        </span>
      </div>
      <Meters
        usage={data?.usage}
        account={data?.account}
        background={data?.background ?? []}
      />
    </header>
  )
}
