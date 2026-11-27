// 工单动态: what the cross-repo tickets have been doing, in sentences. Events
// of one ticket in a row form one card under its title (from → to repo);
// cards fall under day headings, newest first. Plumbing (tool calls,
// checkouts, session init, worktree moves) is left out: it is most of the
// stream and says nothing on its own. Sessions are not here (会话 tab).
import { useLingui } from '@lingui/react/macro'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'

import { BackButton } from '#/components/deck/back-button'
import { Led } from '#/components/deck/led'
import type { LedTone } from '#/components/deck/led'
import { StickyBar } from '#/components/deck/sticky-bar'
import { SectionHeading } from '#/components/ui/section-heading'

import { useGoBack } from '#/lib/go-back'
import { useTicketList } from '#/lib/ticket-sync'
import { getCollab } from '#/lib/runtime-client'
import type { CollabTicket } from '#/lib/runtime-contract'
import { useLocale } from '#/lib/locale-context'
import { useStatusLabel } from './tickets-view'

type Event = Record<string, unknown> & {
  seq?: number | null
  ticket?: string | null
  kind: string
  ts?: string | null
}

const WINDOW = 120

function useLatestEvents() {
  const client = useQueryClient()
  const key = ['runtime', 'collab', 'activity'] as const
  return useQuery({
    queryKey: key,
    enabled: typeof window !== 'undefined',
    refetchInterval: 20_000,
    queryFn: async () => {
      // events are paged forward from a sequence number: learn the head,
      // then read the last WINDOW events.
      const head = await getCollab('events', { limit: 1 })
      const after = Math.max(0, (head.ok ? head.head : 0) - WINDOW)
      const page = await getCollab('events', { after, limit: WINDOW })
      if (!page.ok) {
        if (client.getQueryData(key))
          throw new Error(page.error?.message ?? 'unavailable')
        return { ok: false as const, error: page.error?.message, events: [] }
      }
      return {
        ok: true as const,
        error: undefined,
        events: [...(page.events as Array<Event>)].reverse(),
      }
    },
  })
}

/** event kinds worth a line; the rest is plumbing */
const SHOWN = new Set([
  'created',
  'status',
  'run_start',
  'run_end',
  'milestone',
  'research_done',
  'reply',
  'claimed',
  'challenged',
  'closed',
])

const text = (value: unknown) => (typeof value === 'string' ? value : '')

/** One event as a sentence about its ticket. */
function useSentence() {
  const { t } = useLingui()
  const statusLabel = useStatusLabel()
  return (event: Event) => {
    switch (event.kind) {
      case 'created': {
        const from = text(event.from) || '?'
        const to = text(event.to) || '?'
        return t`opened, ${from} → ${to}`
      }
      case 'status': {
        const label = statusLabel({
          status: text(event.status),
          running: [],
        } as unknown as CollabTicket)
        return t`now ${label}`
      }
      case 'run_start':
        return event.mode === 'read'
          ? t`started researching`
          : t`started working on it`
      case 'run_end':
        return event.exit === 0 || event.exit === undefined
          ? t`run finished`
          : t`run failed`
      case 'research_done':
        return event.ok === false ? t`research failed` : t`research done`
      case 'milestone':
        return text(event.text) || t`made progress`
      case 'reply': {
        const body = text(event.text) || text(event.message)
        return body ? t`replied: ${body}` : t`replied`
      }
      case 'claimed':
        return t`claimed`
      case 'challenged':
        return t`assumptions challenged`
      case 'closed':
        return t({ message: 'closed', context: 'ticket status' })
      default:
        return event.kind
    }
  }
}

export function toneOf(event: Event): LedTone {
  if (event.kind === 'run_start') return 'running'
  if (event.kind === 'run_end')
    return event.exit === 0 || event.exit === undefined ? 'done' : 'error'
  if (event.kind === 'research_done')
    return event.ok === false ? 'error' : 'done'
  // the same lights as the ticket list (ticketTone): ▲ only where you are
  // the one to act; opening a ticket or waiting on the other side is a ○
  if (event.kind === 'status') {
    const status = text(event.status)
    if (status === 'waiting_initiator') return 'waiting'
    if (status === 'failed' || status === 'rejected') return 'error'
    if (status === 'shipped') return 'done'
    if (status === 'in_progress') return 'running'
    return 'muted'
  }
  return 'muted'
}

type Card = { ticket: string; day: string; events: Array<Event> }

/** Consecutive events of one ticket become one card; cards carry their day. */
function cards(events: Array<Event>, dayOf: (iso?: string | null) => string) {
  const out: Array<Card> = []
  for (const event of events) {
    const ticket = event.ticket ?? ''
    const day = dayOf(event.ts)
    const last = out.at(-1)
    if (last && last.ticket === ticket && last.day === day)
      last.events.push(event)
    else out.push({ ticket, day, events: [event] })
  }
  return out
}

function useDayOf() {
  const { t } = useLingui()
  const { locale } = useLocale()
  const format = new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  })
  return (iso?: string | null) => {
    if (!iso) return ''
    const date = new Date(iso)
    const today = new Date()
    const yesterday = new Date(today.getTime() - 86_400_000)
    if (date.toDateString() === today.toDateString()) return t`Today`
    if (date.toDateString() === yesterday.toDateString()) return t`Yesterday`
    return format.format(date)
  }
}

export function ConsoleActivityPage() {
  const { t } = useLingui()
  const { locale } = useLocale()
  const localeParam = locale === 'en' ? undefined : locale
  const back = useGoBack({
    to: '/{-$locale}/console/collab',
    params: { locale: localeParam },
  })
  const events = useLatestEvents()
  const list = useTicketList()
  const sentence = useSentence()
  // the day is the heading above, so a row only needs its time
  const clock = (iso?: string | null) =>
    iso
      ? new Date(iso).toLocaleTimeString(locale === 'zh' ? 'zh-CN' : 'en', {
          hour: '2-digit',
          minute: '2-digit',
        })
      : ''
  const dayOf = useDayOf()
  const tickets = new Map<string, CollabTicket>(
    (list.data?.ok ? list.data.tickets : []).map((ticket) => [
      ticket.id,
      ticket,
    ]),
  )
  // titles also ride on "created" events, for tickets no longer listed
  const created = new Map<string, Event>()
  for (const event of events.data?.events ?? [])
    if (event.kind === 'created' && event.ticket)
      created.set(event.ticket, event)
  const groups = cards(
    (events.data?.events ?? []).filter((event) => SHOWN.has(event.kind)),
    dayOf,
  )
  const byDay: Array<{ day: string; items: Array<Card> }> = []
  for (const group of groups) {
    const last = byDay.at(-1)
    if (last && last.day === group.day) last.items.push(group)
    else byDay.push({ day: group.day, items: [group] })
  }
  return (
    <div className="flex min-h-full w-full flex-1 flex-col bg-brand-surface">
      <StickyBar className="top-0 mx-0 my-0 border-b border-brand-edge bg-brand-surface/95 px-3 pt-[max(env(safe-area-inset-top),0.5rem)] pb-2 md:px-4 md:py-2.5">
        <div className="flex min-h-9 items-center gap-1">
          <BackButton
            onClick={back}
            label={t`Tickets`}
            className="-ml-2 md:hidden"
          />
          <h1 className="min-w-0 flex-1 truncate text-title font-semibold md:text-body">
            {t`Ticket activity`}
          </h1>
          <Link
            to="/{-$locale}/console/collab"
            params={{ locale: localeParam }}
            className="hidden rounded-xl px-2.5 py-1 text-caption text-brand-muted transition-colors hover:bg-brand-soft hover:text-brand-text md:inline-flex"
          >
            {t`Tickets`}
          </Link>
        </div>
      </StickyBar>
      <div className="grid max-w-3xl content-start">
        {events.isError ? (
          <p
            role="status"
            className="border-b border-l-[3px] border-b-brand-edge border-l-brand-waiting bg-brand-waiting/10 px-4 py-2 text-meta text-brand-text"
          >
            {t`Host unreachable right now`}，{t`showing the last copy`}
          </p>
        ) : null}
        {byDay.length === 0 ? (
          <p className="px-4 py-12 text-center text-caption text-brand-muted">
            {events.isPending
              ? t`Loading…`
              : (events.data?.error ?? t`No activity yet`)}
          </p>
        ) : (
          byDay.map((bucket) => (
            <section key={bucket.day} className="grid content-start">
              {bucket.day ? (
                <SectionHeading
                  as="h2"
                  className="top-13 border-b border-brand-edge/80 bg-brand-deck px-3 py-1 text-meta font-semibold text-brand-label md:top-14 md:px-4"
                >
                  {bucket.day}
                </SectionHeading>
              ) : null}
              <div className="bg-brand-surface">
                {bucket.items.map((group) => {
                  const ticket = tickets.get(group.ticket)
                  const origin = created.get(group.ticket)
                  const title =
                    ticket?.title ||
                    text(origin?.title) ||
                    group.ticket.slice(-6)
                  const from = ticket?.from ?? text(origin?.from)
                  const to = ticket?.to ?? text(origin?.to)
                  return (
                    <div
                      key={`${group.ticket}-${group.events[0]?.seq ?? ''}`}
                      className="border-b border-brand-edge px-4 py-3"
                    >
                      <Link
                        to="/{-$locale}/console/collab/$id"
                        params={{ locale: localeParam, id: group.ticket }}
                        className="grid gap-0.5 rounded-lg outline-none hover:text-brand-running focus-visible:ring-2 focus-visible:ring-brand-running"
                      >
                        <span className="line-clamp-2 text-body leading-snug font-semibold">
                          {title}
                        </span>
                        {from || to ? (
                          <span className="font-mono text-meta text-brand-label">
                            {from || '?'} → {to || '?'}
                          </span>
                        ) : null}
                      </Link>
                      <ol className="mt-2 grid gap-1.5">
                        {group.events.map((event) => (
                          <li
                            key={`${event.seq ?? ''}-${event.kind}-${event.ts ?? ''}`}
                            className="grid grid-cols-[0.75rem_minmax(0,1fr)_auto] items-start gap-x-2 text-caption"
                          >
                            <span className="pt-1">
                              <Led tone={toneOf(event)} size={9} />
                            </span>
                            <span className="line-clamp-3 text-brand-text">
                              {sentence(event)}
                            </span>
                            <span className="text-meta text-brand-label tabular-nums">
                              {clock(event.ts)}
                            </span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )
                })}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  )
}
