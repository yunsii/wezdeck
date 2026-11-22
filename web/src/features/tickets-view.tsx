// Ticket list + detail for the collab sections (docs/web-pwa.md):
// - wide (≥768px): split view (Inspector), selection lives in the URL
//   (/console/<base>/$id, replace) so j/k / arrows / clicks are deep-linkable;
// - phone: a deck of ticket keys; a key pushes /console/<base>/$id (full
//   page, back returns via history like a native app).
// All sections share one "all tickets" read and filter on the client, so
// switching tabs costs no request and the status keys can show counts.
import { useLingui } from '@lingui/react/macro'
import { useNavigate, useParams } from '@tanstack/react-router'
import { ChevronLeft, Search } from 'lucide-react'
import { useState } from 'react'

import { Led } from '#/components/deck/led'
import { Segmented } from '#/components/deck/segmented'
import type { LedTone } from '#/components/deck/led'
import { useGoBack } from '#/lib/go-back'
import { useCollab } from '#/lib/collab-query'
import { useLocale } from '#/lib/locale-context'
import type { CollabTicket } from '#/lib/runtime-contract'
import { useIsWide } from '#/lib/use-media'
import { cn } from '#/lib/utils'
import { TicketReading, ticketTone } from './console-collab'
import { useRemoteState } from './console-mode'
import { Inspector, Reading } from './inspector'
import type { InspectorItem } from './inspector'

const ACTIVE_POLL_MS = 2_000
const IDLE_POLL_MS = 30_000

/** Segments on the tickets page; `inbox` is the old 待处理 route's fixed filter. */
export type TicketFilter = 'active' | 'mine' | 'ended' | 'inbox'

const ENDED = new Set(['shipped', 'closed', 'failed', 'rejected'])

const FILTERS: Record<TicketFilter, (t: CollabTicket) => boolean> = {
  active: (t) =>
    t.running.length > 0 ||
    (!ENDED.has(t.status ?? '') && t.status !== 'waiting_initiator'),
  mine: (t) => t.status === 'waiting_initiator',
  ended: (t) => t.running.length === 0 && ENDED.has(t.status ?? ''),
  inbox: (t) => t.status === 'waiting_initiator' || t.status === 'failed',
}

function clock(ms: number) {
  return ms
    ? new Date(ms).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—'
}

export function useAgo() {
  const { locale } = useLocale()
  const format = new Intl.RelativeTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', {
    numeric: 'auto',
    style: 'short',
  })
  return (iso?: string | null) => {
    if (!iso) return ''
    const seconds = (Date.parse(iso) - Date.now()) / 1000
    const abs = Math.abs(seconds)
    if (abs < 60) return format.format(Math.round(seconds), 'second')
    if (abs < 3600) return format.format(Math.round(seconds / 60), 'minute')
    if (abs < 86400) return format.format(Math.round(seconds / 3600), 'hour')
    return format.format(Math.round(seconds / 86400), 'day')
  }
}

export function useStatusLabel() {
  const { t } = useLingui()
  const labels: Partial<Record<string, string>> = {
    submitted: t`submitted`,
    in_progress: t`in progress`,
    waiting_initiator: t`waiting on you`,
    waiting_target: t`waiting on target`,
    shipped: t`shipped`,
    closed: t({ message: 'closed', context: 'ticket status' }),
    rejected: t`rejected`,
    failed: t`failed`,
  }
  return (ticket: CollabTicket) =>
    ticket.running.length > 0
      ? t`running`
      : (labels[ticket.status ?? ''] ?? ticket.status ?? '')
}

const toneText: Record<LedTone, string> = {
  running: 'text-brand-running',
  waiting: 'text-brand-waiting',
  done: 'text-brand-done',
  error: 'text-brand-error',
  muted: 'text-brand-label',
}

/** "Updated HH:MM", or a warning strip when the host / link is down and the list is cached. */
function Freshness({
  updatedAt,
  failed,
}: {
  updatedAt: number
  failed: boolean
}) {
  const { t } = useLingui()
  const remote = useRemoteState()
  const time = clock(updatedAt)
  const stale = remote.mode === 'host-offline' || failed
  const reason =
    remote.mode === 'host-offline'
      ? t`Host offline`
      : t`Host unreachable right now`
  return (
    <p
      role={stale ? 'status' : undefined}
      data-testid="freshness"
      data-stale={stale ? 'true' : 'false'}
      className={cn(
        'flex items-center gap-2 text-xs',
        stale
          ? 'rounded-[10px] border border-brand-waiting/40 bg-brand-waiting/10 px-3 py-2 text-brand-text'
          : 'text-brand-label',
      )}
    >
      {stale ? <Led tone="waiting" size={11} /> : null}
      {stale ? `${reason}，${t`data as of ${time}`}` : t`Updated ${time}`}
    </p>
  )
}

function SearchBox({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  const { t } = useLingui()
  return (
    <label className="flex min-h-11 flex-1 items-center gap-2 rounded-[10px] border border-brand-edge bg-brand-deck px-3 text-[15px] focus-within:ring-2 focus-within:ring-brand-running md:min-h-9 md:text-sm">
      <Search size={15} aria-hidden className="text-brand-label" />
      <input
        data-search
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t`Filter by title, repo or id`}
        aria-label={t`Filter tickets`}
        className="min-w-0 flex-1 bg-transparent py-1.5 outline-none placeholder:text-brand-label"
      />
    </label>
  )
}

function StatusSegments({
  tickets,
  value,
  onChange,
}: {
  tickets: Array<CollabTicket>
  value: TicketFilter
  onChange: (value: TicketFilter) => void
}) {
  const { t } = useLingui()
  const count = (filter: TicketFilter) => tickets.filter(FILTERS[filter]).length
  const active = count('active')
  const mine = count('mine')
  const ended = count('ended')
  return (
    <Segmented
      label={t`Status`}
      value={value}
      onChange={onChange}
      className="md:max-w-md"
      options={[
        { value: 'active', label: t`In progress ${active}` },
        { value: 'mine', label: t`Waiting on you ${mine}` },
        { value: 'ended', label: t`Ended ${ended}` },
      ]}
    />
  )
}

export function TicketsView({
  base,
  filter: fixedFilter,
  top,
  empty,
}: {
  base: 'collab' | 'inbox'
  /** fixed filter (inbox); omitted = status keys */
  filter?: TicketFilter
  top?: React.ReactNode
  empty: string
}) {
  const { t } = useLingui()
  const { id } = useParams({ strict: false })
  const navigate = useNavigate()
  const { locale } = useLocale()
  const localeParam = locale === 'en' ? undefined : locale
  // opened from the list → back like a native page; opened directly (a
  // notification / shared link) → the list, without a history entry
  const back = useGoBack({
    to:
      base === 'inbox'
        ? '/{-$locale}/console/inbox'
        : '/{-$locale}/console/collab',
    params: { locale: localeParam },
  })
  const wide = useIsWide()
  const statusLabel = useStatusLabel()
  const health = useCollab('health', {}, { refetchInterval: 15_000 })
  const poll = (health.data?.running ?? 0) > 0 ? ACTIVE_POLL_MS : IDLE_POLL_MS
  const list = useCollab('list', { limit: 200 }, { refetchInterval: poll })
  const [chosen, setChosen] = useState<TicketFilter>('active')
  const filter = fixedFilter ?? chosen
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const all: Array<CollabTicket> = list.data?.ok ? list.data.tickets : []
  const tickets = all
    .filter(FILTERS[filter])
    .filter(
      (ticket) =>
        !needle ||
        [ticket.id, ticket.title, ticket.from, ticket.to]
          .filter(Boolean)
          .some((field) => String(field).toLowerCase().includes(needle)),
    )
  const unavailable =
    list.data && !list.data.ok ? list.data.error?.message : undefined
  const emptyText = list.isPending
    ? t`Loading…`
    : unavailable
      ? t`Collab data unavailable: ${unavailable}`
      : empty
  const open = (ticketId: string, replace = false) =>
    void navigate({
      to:
        base === 'inbox'
          ? '/{-$locale}/console/inbox/$id'
          : '/{-$locale}/console/collab/$id',
      params: { locale: localeParam, id: ticketId },
      replace,
    })
  const freshness = (
    <Freshness updatedAt={list.dataUpdatedAt} failed={list.isError} />
  )
  const keys = fixedFilter ? null : (
    <StatusSegments tickets={all} value={chosen} onChange={setChosen} />
  )

  if (wide) {
    const items: Array<InspectorItem> = tickets.map((ticket) => ({
      id: ticket.id,
      name: ticket.title || ticket.id,
      detail: `${ticket.from ?? '?'} → ${ticket.to ?? '?'}`,
      status: statusLabel(ticket),
      tone: ticketTone(ticket),
    }))
    const current =
      items.find((item) => item.id === id)?.id ?? id ?? items.at(0)?.id ?? ''
    return (
      <div className="grid h-full min-h-0 grid-rows-[auto_auto_auto_minmax(0,1fr)] gap-3">
        <div>{top}</div>
        {keys ?? <div />}
        {freshness}
        <Inspector
          label={t`Collab tickets`}
          empty={emptyText}
          items={items}
          selected={current}
          onSelect={(next) => open(next, true)}
          toolbar={<SearchBox value={query} onChange={setQuery} />}
          reading={
            current ? (
              <TicketReading id={current} poll={poll} onOpen={open} />
            ) : (
              <Reading
                title={t`No ticket selected`}
                body={t`Tickets appear here when ticket files or runs cross-repo work.`}
              />
            )
          }
        />
      </div>
    )
  }

  if (id) {
    return (
      <div className="grid content-start gap-3">
        <button
          type="button"
          onClick={back}
          className="-ml-2 inline-flex min-h-11 w-fit items-center gap-1 px-2 text-[15px] text-brand-muted"
        >
          <ChevronLeft size={20} aria-hidden />
          {t`Back`}
        </button>
        <TicketReading id={id} poll={poll} onOpen={open} />
      </div>
    )
  }

  return (
    <div className="grid content-start gap-3">
      {top}
      {keys}
      <SearchBox value={query} onChange={setQuery} />
      {freshness}
      <TicketKeys tickets={tickets} empty={emptyText} onOpen={open} />
    </div>
  )
}

export function RepoRoute({
  from,
  to,
}: {
  from?: string | null
  to?: string | null
}) {
  const tag =
    'max-w-[9.5rem] truncate rounded-full border border-brand-edge px-2 py-0.5 text-xs text-brand-muted'
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <span className={tag}>{from ?? '?'}</span>
      <span aria-hidden className="text-brand-label">
        →
      </span>
      <span className={tag}>{to ?? '?'}</span>
    </span>
  )
}

/** Phone list: one key per ticket. */
function TicketKeys({
  tickets,
  empty,
  onOpen,
}: {
  tickets: Array<CollabTicket>
  empty: string
  onOpen: (id: string) => void
}) {
  const { t } = useLingui()
  const ago = useAgo()
  const statusLabel = useStatusLabel()
  if (tickets.length === 0) {
    return (
      <p className="rounded-[16px] bg-brand-surface px-4 py-10 text-center text-sm text-brand-muted">
        {empty}
      </p>
    )
  }
  return (
    <ul
      aria-label={t`Collab tickets`}
      className="overflow-hidden rounded-[16px] bg-brand-surface"
    >
      {tickets.map((ticket) => {
        const tone = ticketTone(ticket) ?? 'muted'
        return (
          <li
            key={ticket.id}
            className="border-b border-brand-edge last:border-b-0"
          >
            <button
              type="button"
              data-ticket={ticket.id}
              onClick={() => onOpen(ticket.id)}
              className="key-press grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand-running focus-visible:ring-inset"
            >
              <span className="pt-1">
                <Led tone={tone} size={13} />
              </span>
              <span className="line-clamp-2 text-[16px] leading-snug font-semibold text-brand-text">
                {ticket.title || ticket.id}
              </span>
              <span className="pt-0.5 text-xs text-brand-label">
                {ago(ticket.updated_at)}
              </span>
              <span className="col-start-2 col-end-4 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className={cn('text-xs font-medium', toneText[tone])}>
                  {statusLabel(ticket)}
                </span>
                <RepoRoute from={ticket.from} to={ticket.to} />
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
