// Ticket list + detail for the collab sections (docs/web-pwa.md):
// - wide (≥768px): split view (Inspector), selection lives in the URL
//   (/console/<base>/$id, replace) so j/k / arrows / clicks are deep-linkable;
// - phone: list only, a row pushes /console/<base>/$id (full page, back
//   returns via history like a native app).
import { useLingui } from '@lingui/react/macro'
import { useNavigate, useParams, useRouter } from '@tanstack/react-router'
import { ChevronLeft, Search } from 'lucide-react'
import { useState } from 'react'

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

const toneDot = {
  running: 'bg-brand-running',
  waiting: 'bg-brand-waiting',
  done: 'bg-brand-done',
  error: 'bg-brand-error',
  muted: 'bg-brand-label',
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

/** "updated HH:MM", or a warning band when the host / link is down and the list is cached. */
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
  if (remote.mode === 'host-offline' || failed) {
    const reason =
      remote.mode === 'host-offline'
        ? t`Host offline`
        : t`Host unreachable right now`
    return (
      <p
        role="status"
        data-testid="freshness"
        data-stale="true"
        className="border border-brand-waiting bg-brand-waiting/10 px-3 py-2 text-xs text-brand-text"
      >
        {reason} · {t`data as of ${time}`}
      </p>
    )
  }
  return (
    <p
      data-testid="freshness"
      data-stale="false"
      className="text-xs text-brand-label"
    >
      {t`Updated ${time}`}
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
    <label className="flex min-h-10 flex-1 items-center gap-2 border border-brand-border bg-brand-deck px-2 text-sm">
      <Search size={14} aria-hidden className="text-brand-label" />
      <input
        data-search
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t`Filter by title, repo or id`}
        aria-label={t`Filter tickets`}
        className="min-w-0 flex-1 bg-transparent py-1.5 outline-none"
      />
    </label>
  )
}

export function TicketsView({
  base,
  status,
  top,
  toolbar,
  empty,
}: {
  base: 'collab' | 'inbox'
  status: string
  top?: React.ReactNode
  toolbar?: React.ReactNode
  empty: string
}) {
  const { t } = useLingui()
  const { id } = useParams({ strict: false })
  const navigate = useNavigate()
  const router = useRouter()
  const { locale } = useLocale()
  const localeParam = locale === 'en' ? undefined : locale
  const wide = useIsWide()
  const statusLabel = useStatusLabel()
  const health = useCollab('health', {}, { refetchInterval: 15_000 })
  const poll = (health.data?.running ?? 0) > 0 ? ACTIVE_POLL_MS : IDLE_POLL_MS
  const list = useCollab(
    'list',
    { limit: 100, status },
    { refetchInterval: poll },
  )
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const tickets: Array<CollabTicket> = (
    list.data?.ok ? list.data.tickets : []
  ).filter(
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

  if (wide) {
    const items: Array<InspectorItem> = tickets.map((ticket) => ({
      id: ticket.id,
      name: ticket.title || ticket.id,
      detail: `${ticket.from ?? '?'} → ${ticket.to ?? '?'} · ${
        ticket.progress?.message ?? ticket.phase ?? ''
      }`,
      status: statusLabel(ticket),
      tone: ticketTone(ticket),
    }))
    const current =
      items.find((item) => item.id === id)?.id ?? id ?? items.at(0)?.id ?? ''
    return (
      <div className="grid h-full min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] gap-3">
        <div>{top}</div>
        {freshness}
        <Inspector
          label={t`Collab tickets`}
          empty={emptyText}
          items={items}
          selected={current}
          onSelect={(next) => open(next, true)}
          toolbar={
            <div className="flex flex-wrap items-center gap-2">
              <SearchBox value={query} onChange={setQuery} />
              {toolbar}
            </div>
          }
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
    const back = () => {
      // Opened from the list: go back like a native page. Opened from a
      // notification / shared link (no history): go to the list instead.
      if (window.history.length > 1) router.history.back()
      else
        void navigate({
          to:
            base === 'inbox'
              ? '/{-$locale}/console/inbox'
              : '/{-$locale}/console/collab',
          params: { locale: localeParam },
        })
    }
    return (
      <div className="grid content-start gap-3">
        <button
          type="button"
          onClick={back}
          className="-ml-2 inline-flex min-h-11 w-fit items-center gap-1 px-2 text-sm text-brand-muted"
        >
          <ChevronLeft size={18} aria-hidden />
          {t`Back`}
        </button>
        <TicketReading id={id} poll={poll} onOpen={open} />
      </div>
    )
  }

  return (
    <div className="grid content-start gap-3">
      {top}
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={query} onChange={setQuery} />
        {toolbar}
      </div>
      {freshness}
      <MobileList tickets={tickets} empty={emptyText} onOpen={open} />
    </div>
  )
}

function MobileList({
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
    return <p className="py-8 text-center text-sm text-brand-muted">{empty}</p>
  }
  return (
    <ul
      aria-label={t`Collab tickets`}
      className="-mx-4 divide-y divide-brand-border border-y border-brand-border"
    >
      {tickets.map((ticket) => {
        const tone = ticketTone(ticket) ?? 'muted'
        const status = statusLabel(ticket)
        return (
          <li key={ticket.id}>
            <button
              type="button"
              data-ticket={ticket.id}
              onClick={() => onOpen(ticket.id)}
              className="grid min-h-16 w-full grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 px-4 py-3 text-left active:bg-brand-soft"
            >
              <span
                aria-hidden
                className={cn('mt-1.5 size-2 rounded-full', toneDot[tone])}
              />
              <span className="line-clamp-2 text-[15px] leading-snug text-brand-text">
                {ticket.title || ticket.id}
              </span>
              <span className="text-xs text-brand-label">{status}</span>
              <span className="col-start-2 col-end-4 truncate text-xs text-brand-label">
                {ticket.from ?? '?'} → {ticket.to ?? '?'}
                {ticket.progress?.message
                  ? ` · ${ticket.progress.message}`
                  : ''}
                {ticket.updated_at ? ` · ${ago(ticket.updated_at)}` : ''}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
