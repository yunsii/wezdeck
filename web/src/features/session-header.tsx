// Top of a session page, pinned while the thread scrolls under it: back,
// which session this is, its status, and three meters — context used,
// the Claude account's 5-hour and 7-day limits (reported by Claude Code to
// its status line, scripts/runtime/claude-statusline-tap.sh). Tapping the
// meters shows the spend (model, output, cache hit), how fresh the limits
// are, and the background tasks (counted in the meter row). The header's height is shared
// as --session-head so the sticky prompt (chat-sticky.tsx) sits under it.
import { useLingui } from '@lingui/react/macro'
import { ChevronDown, ChevronLeft, Info } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { Led } from '#/components/deck/led'
import { cn } from '#/lib/utils'
import { useStatusText } from './console-sessions'
import type {
  AccountLimits,
  BgTask,
  Detail,
  RateWindow,
  Usage,
} from './console-sessions'
import { useAgo } from './tickets-view'
import { SessionInfo, metaValue } from './session-info'
import {
  NextWaitingChip,
  SessionSwitcher,
  useSessionKeys,
  useSessionNav,
} from './session-switcher'
import { Button } from '#/components/ui/button'

/** a meter appears once its share reaches this (amber from here on) */
const NEAR_FULL = 75

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
      : 0
  // a snapshot taken before its window reset says nothing about now
  const current = (w?: RateWindow) =>
    w && !(w.resets_at && w.resets_at * 1000 < Date.now()) ? w : undefined
  const five = current(account?.five_hour)
  const week = current(account?.seven_day)
  // meters only appear once something is close to full; the numbers are
  // always in 会话信息 (ⓘ)
  const showContext = context >= NEAR_FULL
  const showFive = Boolean(five && five.used_percentage >= NEAR_FULL)
  const showWeek = Boolean(week && week.used_percentage >= NEAR_FULL)
  if (!showContext && !showFive && !showWeek && !background.length) return null
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
      <Button
        variant="plain"
        type="button"
        data-testid="session-usage"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex min-w-0 flex-wrap items-center gap-1.5 text-left"
      >
        {showContext ? <Meter label={t`Context`} percent={context} /> : null}
        {showFive && five ? (
          <Meter
            label={t`5 h`}
            percent={five.used_percentage}
            note={fiveReset ? t`resets ${fiveReset}` : undefined}
          />
        ) : null}
        {showWeek && week ? (
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
      </Button>
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
  id,
  data,
  onBack,
  onRename,
  renameDisabled,
}: {
  id: string
  data: Detail | undefined
  onBack: () => void
  /** Paste `/rename <title>` into the agent TUI (Claude and Grok both honor it). */
  onRename?: (title: string) => void
  renameDisabled?: boolean
}) {
  const { t } = useLingui()
  const statusText = useStatusText()
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
    (data &&
      (data.title ||
        metaValue(data, 'cwd').split('/').filter(Boolean).at(-1) ||
        data.id.slice(0, 8))) ||
    ''
  // the page shows running (typing dots) and done (the reply) by itself;
  // the header only speaks up when the agent needs the human
  const long = data
    ? statusText(
        data.status,
        data.waiting_kind,
        data.running_kind,
        data.background?.length ?? 0,
      )
    : undefined
  return (
    <header
      ref={head}
      data-testid="session-header"
      className="sticky top-[env(safe-area-inset-top)] z-30 -mx-2.5 -mt-1 grid gap-1.5 border-b border-brand-edge bg-brand-deck/95 px-2.5 pt-1 pb-2 backdrop-blur"
    >
      <div className="flex min-w-0 items-center gap-1">
        <Button
          variant="plain"
          type="button"
          onClick={onBack}
          aria-label={t({ message: 'Sessions', context: 'nav' })}
          // the list sits beside the conversation on a wide screen
          className="-ml-2 inline-flex size-11 shrink-0 items-center justify-center text-brand-muted md:hidden"
        >
          <ChevronLeft size={22} aria-hidden />
        </Button>
        <div className="grid min-w-0 flex-1">
          {/* Alt+g / Alt+x at the desk: pick another session */}
          <Button
            variant="plain"
            type="button"
            onClick={openSwitcher}
            aria-haspopup="dialog"
            data-testid="session-title"
            title={t`Switch session (Alt+g)`}
            className="flex min-w-0 items-center gap-1 text-left text-[16px] leading-tight font-semibold"
          >
            <span className="truncate">{title || t`Loading…`}</span>
            <ChevronDown
              size={15}
              aria-hidden
              className="shrink-0 text-brand-label"
            />
          </Button>
          {data?.agent || data?.branch ? (
            <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-brand-label">
              {data.agent && data.agent !== 'agent' ? (
                <span className="shrink-0 rounded-[5px] bg-brand-surface px-1.5 font-mono leading-[1.35rem]">
                  {data.agent}
                </span>
              ) : null}
              {data.branch ? (
                <span className="truncate font-mono">{data.branch}</span>
              ) : null}
            </span>
          ) : null}
        </div>
        {data?.waiting_kind ? (
          <span
            title={long}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-brand-waiting/15 px-2 py-0.5 text-[12.5px] text-brand-text"
          >
            <Led tone="waiting" size={10} />
            {t`Needs you`}
          </span>
        ) : (
          <NextWaitingChip
            count={nav.otherWaiting.length}
            onNext={() => nav.jump('waiting')}
          />
        )}
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
      <Meters
        usage={data?.usage}
        account={data?.account}
        background={data?.background ?? []}
      />
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
