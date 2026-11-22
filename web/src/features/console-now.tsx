// 现在: the phone's home. Three bands — needs you, running, recently
// active (top 5 by conversation activity, including idle) — then a link
// into 会话 / 动态. Everything links into its detail.
import { useLingui } from '@lingui/react/macro'
import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'

import { Led } from '#/components/deck/led'
import { useCollab } from '#/lib/collab-query'
import { useLocale } from '#/lib/locale-context'
import type { CollabTicket } from '#/lib/runtime-contract'
import { ticketTone } from './console-collab'
import {
  humanPrompt,
  isBusy,
  sessionTone,
  useSessions,
  useStatusText,
} from './console-sessions'
import type { SessionCard } from './console-sessions'
import { useAgo, useStatusLabel } from './tickets-view'

const RECENT_CAP = 5

const sessionTs = (ms?: number) => (ms ? new Date(ms).toISOString() : undefined)

function Group({
  title,
  children,
  footer,
}: {
  title: string
  children: React.ReactNode
  footer?: React.ReactNode
}) {
  return (
    <section className="grid gap-2">
      <h2 className="text-[19px] font-bold">{title}</h2>
      <ul className="overflow-hidden rounded-[16px] bg-brand-surface">
        {children}
        {footer ? (
          <li className="border-t border-brand-edge last:border-b-0">
            {footer}
          </li>
        ) : null}
      </ul>
    </section>
  )
}

const needsYouSession = (row: SessionCard) =>
  Boolean(row.waiting_kind) || row.status === 'waiting'

export function ConsoleNowPage() {
  const { t } = useLingui()
  const { locale } = useLocale()
  const localeParam = locale === 'en' ? undefined : locale
  const ago = useAgo()
  const statusLabel = useStatusLabel()
  const statusText = useStatusText()
  const list = useCollab('list', { limit: 200 }, { refetchInterval: 15_000 })
  const sessions = useSessions()
  const tickets: Array<CollabTicket> = list.data?.ok ? list.data.tickets : []
  const live: Array<SessionCard> = sessions.data?.sessions ?? []

  const needTickets = tickets.filter(
    (ticket) =>
      ticket.status === 'waiting_initiator' || ticket.status === 'failed',
  )
  const needSessions = live.filter(needsYouSession)
  const runningTickets = tickets.filter((ticket) => ticket.running.length > 0)
  const workingSessions = live.filter((row) => isBusy(row))

  const claimed = new Set([
    ...needSessions.map((row) => row.id),
    ...workingSessions.map((row) => row.id),
  ])
  const recentSessions = [...live]
    .filter((row) => !claimed.has(row.id))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, RECENT_CAP)

  const needCount = needTickets.length + needSessions.length
  const runCount = workingSessions.length + runningTickets.length
  const recentCount = recentSessions.length
  const summary = t`${needCount} need you, ${runCount} running, ${recentCount} recent`

  const ticketRow = (ticket: CollabTicket, right: string) => (
    <li key={ticket.id} className="border-b border-brand-edge last:border-b-0">
      <Link
        to="/{-$locale}/console/collab/$id"
        params={{ locale: localeParam, id: ticket.id }}
        data-ticket={ticket.id}
        className="key-press flex min-h-14 items-start gap-3 px-4 py-3"
      >
        <span className="pt-1.5">
          <Led tone={ticketTone(ticket) ?? 'muted'} size={12} />
        </span>
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="line-clamp-2 text-[16px] leading-snug font-semibold">
            {ticket.title || ticket.id}
          </span>
          <span className="flex justify-between gap-2 text-sm text-brand-muted">
            <span className="truncate">
              {ticket.progress?.message ??
                `${statusLabel(ticket)}，${ticket.from ?? '?'} → ${ticket.to ?? '?'}`}
            </span>
            <span className="shrink-0">{right}</span>
          </span>
        </span>
      </Link>
    </li>
  )

  const sessionTitle = (row: SessionCard) =>
    row.window ||
    row.worktree?.split('/').filter(Boolean).at(-1) ||
    row.cwd.split('/').filter(Boolean).at(-1) ||
    row.id.slice(0, 8)

  const sessionTag = (text: string) => (
    <span className="shrink-0 rounded-full bg-brand-deck px-1.5 py-0.5 text-[11px] text-brand-label">
      {text}
    </span>
  )

  const sessionRow = (row: SessionCard) => {
    const prompt = humanPrompt(row.last_prompt)
    const status = statusText(
      row.status,
      row.waiting_kind,
      row.running_kind,
      row.background?.length ?? 0,
    )
    const pane =
      row.pane_role === 'primary'
        ? t`Primary`
        : row.pane_role === 'secondary'
          ? t`Secondary`
          : ''
    return (
      <li key={row.id} className="border-b border-brand-edge last:border-b-0">
        <Link
          to="/{-$locale}/console/sessions/$id"
          params={{ locale: localeParam, id: row.id }}
          data-session={row.id}
          className="key-press flex min-h-14 items-start gap-3 px-4 py-3"
        >
          <span className="pt-1.5">
            <Led tone={sessionTone(row.status, row.waiting_kind)} size={12} />
          </span>
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="flex items-baseline justify-between gap-2">
              <span className="truncate text-[16px] font-semibold">
                {sessionTitle(row)}
              </span>
              <span className="shrink-0 text-xs text-brand-label">
                {ago(sessionTs(row.ts))}
              </span>
            </span>
            <span className="truncate text-sm text-brand-muted">
              {prompt || t`No human message yet`}
            </span>
            <span className="flex min-w-0 flex-wrap items-center gap-1">
              {pane ? sessionTag(pane) : null}
              {row.agent && row.agent !== 'agent'
                ? sessionTag(row.agent)
                : null}
              {row.name && row.name !== row.agent ? sessionTag(row.name) : null}
              {status ? sessionTag(status) : null}
              {row.branch ? sessionTag(row.branch) : null}
            </span>
          </span>
        </Link>
      </li>
    )
  }

  const empty =
    needCount + runCount + recentCount === 0 &&
    !list.isPending &&
    !sessions.isPending

  return (
    <div className="grid max-w-2xl content-start gap-5">
      <h1 className="hidden text-base font-semibold md:block">{t`Now`}</h1>
      <p className="-mt-2 text-[16px] text-brand-muted md:mt-0">{summary}</p>
      {needCount > 0 ? (
        <Group title={t`Needs you`}>
          {needTickets.map((ticket) =>
            ticketRow(ticket, ago(ticket.updated_at)),
          )}
          {needSessions.map(sessionRow)}
        </Group>
      ) : null}
      {runCount > 0 ? (
        <Group title={t`Running now`}>
          {workingSessions.map(sessionRow)}
          {runningTickets.map((ticket) =>
            ticketRow(ticket, ago(ticket.updated_at)),
          )}
        </Group>
      ) : null}
      {recentCount > 0 ? (
        <Group
          title={t`Recently active`}
          footer={
            <Link
              to="/{-$locale}/console/sessions"
              params={{ locale: localeParam }}
              className="key-press flex min-h-12 items-center justify-between px-4 text-[15px]"
            >
              {t`All sessions`}
              <ChevronRight
                size={18}
                aria-hidden
                className="text-brand-label"
              />
            </Link>
          }
        >
          {recentSessions.map(sessionRow)}
        </Group>
      ) : null}
      {empty ? (
        <p className="rounded-[16px] bg-brand-surface px-4 py-10 text-center text-sm text-brand-muted">
          {t`Nothing needs you and nothing is running.`}
        </p>
      ) : null}
      {list.isPending && needCount + runCount + recentCount === 0 ? (
        <p className="rounded-[16px] bg-brand-surface px-4 py-10 text-center text-sm text-brand-muted">
          {t`Loading…`}
        </p>
      ) : null}
      <Link
        to="/{-$locale}/console/activity"
        params={{ locale: localeParam }}
        className="key-press flex min-h-12 items-center justify-between rounded-[16px] bg-brand-surface px-4 text-[15px]"
      >
        {t`All activity`}
        <ChevronRight size={18} aria-hidden className="text-brand-label" />
      </Link>
    </div>
  )
}
