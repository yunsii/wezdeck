// 现在: the phone's home. One screen answers "what needs me, what is
// running": tickets waiting on you or failed, sessions waiting for input,
// and what is working right now. Everything links into its detail.
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
} from './console-sessions'
import type { SessionCard } from './console-sessions'
import { useAgo, useStatusLabel } from './tickets-view'

function Group({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="grid gap-2">
      <h2 className="text-[19px] font-bold">{title}</h2>
      <ul className="overflow-hidden rounded-[16px] bg-brand-surface">
        {children}
      </ul>
    </section>
  )
}

export function ConsoleNowPage() {
  const { t } = useLingui()
  const { locale } = useLocale()
  const localeParam = locale === 'en' ? undefined : locale
  const ago = useAgo()
  const statusLabel = useStatusLabel()
  const list = useCollab('list', { limit: 200 }, { refetchInterval: 15_000 })
  const sessions = useSessions()
  const tickets: Array<CollabTicket> = list.data?.ok ? list.data.tickets : []
  const needs = tickets.filter(
    (ticket) =>
      ticket.status === 'waiting_initiator' || ticket.status === 'failed',
  )
  const running = tickets.filter((ticket) => ticket.running.length > 0)
  const live: Array<SessionCard> = sessions.data?.sessions ?? []
  // "done" (turn ended) and background-only sessions take your next message
  // idle (archived but still open) sessions live on the 会话 tab, not here
  const waitingSessions = live.filter(
    (row) => !isBusy(row) && row.status !== 'idle',
  )
  const workingSessions = live.filter((row) => isBusy(row))
  const needCount = needs.length
  const runCount = workingSessions.length + running.length
  const summary = t`${needCount} tickets need you, ${runCount} things are running`

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
  const sessionRow = (row: SessionCard) => (
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
          <span className="truncate text-[16px] font-semibold">
            {row.name || row.window}
          </span>
          <span className="truncate text-sm text-brand-muted">
            {humanPrompt(row.last_prompt) || row.window}
          </span>
        </span>
      </Link>
    </li>
  )

  return (
    <div className="grid max-w-2xl content-start gap-5">
      <h1 className="hidden text-base font-semibold md:block">{t`Now`}</h1>
      <p className="-mt-2 text-[16px] text-brand-muted md:mt-0">{summary}</p>
      {needs.length > 0 ? (
        <Group title={t`Needs you`}>
          {needs.map((ticket) => ticketRow(ticket, ago(ticket.updated_at)))}
        </Group>
      ) : null}
      {waitingSessions.length > 0 ? (
        <Group title={t`Sessions waiting for you`}>
          {waitingSessions.map(sessionRow)}
        </Group>
      ) : null}
      {running.length + workingSessions.length > 0 ? (
        <Group title={t`Running now`}>
          {workingSessions.map(sessionRow)}
          {running.map((ticket) => ticketRow(ticket, ago(ticket.updated_at)))}
        </Group>
      ) : null}
      {needs.length + live.length + running.length === 0 ? (
        <p className="rounded-[16px] bg-brand-surface px-4 py-10 text-center text-sm text-brand-muted">
          {list.isPending
            ? t`Loading…`
            : t`Nothing needs you and nothing is running.`}
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
