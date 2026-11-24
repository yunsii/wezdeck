// Ticket list + detail for the collab sections (docs/web-pwa.md):
// - wide (≥768px): a split like 会话 (sticky list + ticket), selection lives in the URL
//   (/console/<base>/$id, replace) so j/k / arrows / clicks are deep-linkable;
// - phone: a deck of ticket keys; a key pushes /console/<base>/$id (full
//   page, back returns via history like a native app).
// All sections share one "all tickets" read and filter on the client, so
// switching tabs costs no request and the status keys can show counts.
import { useLingui } from '@lingui/react/macro'
import { useNavigate, useParams } from '@tanstack/react-router'
import { Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { BackButton } from '#/components/deck/back-button'
import { RemoteBadge } from './remote-badge'

import { Led } from '#/components/deck/led'
import { Segmented } from '#/components/deck/segmented'
import { useGoBack } from '#/lib/go-back'
import { useTicketHealth, useTicketList } from '#/lib/ticket-sync'
import { useLocale } from '#/lib/locale-context'
import type { CollabTicket } from '#/lib/runtime-contract'
import { useIsWide } from '#/lib/use-media'
import { cn } from '#/lib/utils'
import { TicketReading } from './console-collab'
import { useRemoteState } from './console-mode'
import { Reading } from './inspector'
import { nextInCycle } from './session-order'
import { NewTicketButton } from './ticket-new'
import { TicketKeys } from './ticket-keys'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'

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

/** newest activity first */
const byUpdated = (a: CollabTicket, b: CollabTicket) =>
  Date.parse(b.updated_at ?? '') - Date.parse(a.updated_at ?? '')

const QUIET_DAYS = 7

/**
 * 进行中 lists what is moving: a ticket nobody touched for QUIET_DAYS (not
 * running, not waiting on you) folds into 较早 at the end — 19- to 62-day-old
 * 已提交 tickets used to push the live ones down.
 */
export function splitQuiet(tickets: Array<CollabTicket>, now = Date.now()) {
  const cutoff = now - QUIET_DAYS * 86_400_000
  const quiet = (ticket: CollabTicket) =>
    ticket.running.length === 0 &&
    ticket.status !== 'waiting_initiator' &&
    Date.parse(ticket.updated_at ?? '') < cutoff
  return {
    recent: tickets.filter((ticket) => !quiet(ticket)),
    older: tickets.filter(quiet),
  }
}

function clock(ms: number) {
  return ms
    ? new Date(ms).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—'
}

/**
 * "now" under a minute, then minutes / hours / days: a seconds count
 * re-rendered with every poll (1–2.5 s) and shifted the rest of its line
 * each time (docs/web-pwa.md "Layout stability")
 */
export function formatAgo(
  iso: string | null | undefined,
  now: number,
  locale: string,
) {
  if (!iso) return ''
  const format = new Intl.RelativeTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', {
    numeric: 'auto',
    style: 'short',
  })
  const seconds = (Date.parse(iso) - now) / 1000
  const abs = Math.abs(seconds)
  if (abs < 60) return format.format(0, 'second')
  if (abs < 3600) return format.format(Math.round(seconds / 60), 'minute')
  if (abs < 86400) return format.format(Math.round(seconds / 3600), 'hour')
  return format.format(Math.round(seconds / 86400), 'day')
}

export function useAgo() {
  const { locale } = useLocale()
  return (iso?: string | null) => formatAgo(iso, Date.now(), locale)
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
        'flex items-center gap-2 text-meta',
        stale
          ? 'rounded-xl border border-brand-waiting/40 bg-brand-waiting/10 px-3 py-2 text-brand-text'
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
  autoFocus = false,
}: {
  value: string
  onChange: (value: string) => void
  autoFocus?: boolean
}) {
  const { t } = useLingui()
  return (
    <label
      data-text-field
      className="flex min-h-11 flex-1 items-center gap-2 rounded-xl bg-brand-deck px-3 text-body md:min-h-9 md:text-body"
    >
      <Search size={15} aria-hidden className="text-brand-label" />
      <Input
        variant="bare"
        data-search
        autoFocus={autoFocus}
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
        {
          value: 'active',
          label: t({ message: 'In progress', context: 'filter' }),
          count: active,
        },
        {
          value: 'mine',
          label: t({ message: 'Waiting on you', context: 'filter' }),
          count: mine,
        },
        {
          value: 'ended',
          label: t({ message: 'Ended', context: 'filter' }),
          count: ended,
        },
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
  const health = useTicketHealth()
  const poll = (health.data?.running ?? 0) > 0 ? ACTIVE_POLL_MS : IDLE_POLL_MS
  const list = useTicketList()
  const [chosen, setChosen] = useState<TicketFilter>('active')
  const filter = fixedFilter ?? chosen
  const [query, setQuery] = useState('')
  // phone: the search field opens from an icon instead of taking a row
  const [searching, setSearching] = useState(false)
  const needle = query.trim().toLowerCase()
  const all: Array<CollabTicket> = list.data?.ok ? list.data.tickets : []
  const tickets = all
    .filter(FILTERS[filter])
    .sort(byUpdated)
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
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <StatusSegments tickets={all} value={chosen} onChange={setChosen} />
      </div>
      {wide ? null : (
        <Button
          variant="ghost"
          size="icon"
          type="button"
          aria-label={t`Filter tickets`}
          aria-pressed={searching}
          onClick={() => {
            setSearching(!searching)
            if (searching) setQuery('')
          }}
          className="size-11 shrink-0 rounded-xl"
        >
          <Search size={18} aria-hidden />
        </Button>
      )}
      <NewTicketButton />
    </div>
  )

  const { recent, older } =
    filter === 'active' && !needle
      ? splitQuiet(tickets)
      : { recent: tickets, older: [] }

  if (wide) {
    // a split like 会话 (session-split.tsx): the list sticky on the left, the
    // ticket beside it in the page scroll, j / k move through the list
    const current = id ?? recent.at(0)?.id ?? older.at(0)?.id ?? ''
    return (
      <div className="grid content-start gap-3">
        {top}
        {keys}
        {list.isError ? freshness : null}
        <TicketListKeys
          ids={[...recent, ...older].map((ticket) => ticket.id)}
          current={current}
          onGo={(next) => open(next, true)}
        />
        <div className="grid grid-cols-[minmax(300px,360px)_minmax(0,1fr)] items-start">
          <aside
            aria-label={t`Collab tickets`}
            className="vt-split-list sticky top-4 grid h-[calc(100dvh-4.25rem)] content-start gap-3 overflow-y-auto border-r border-brand-edge pr-[var(--page-x)] pb-1 [scrollbar-gutter:stable_both-edges]"
          >
            <SearchBox value={query} onChange={setQuery} />
            <TicketKeys
              tickets={recent}
              older={older}
              empty={emptyText}
              base={base}
              selected={current}
            />
          </aside>
          <div
            className="vt-split-pane ml-[var(--page-x)] min-w-0 rounded-2xl bg-brand-surface p-5"
            data-testid="ticket-pane"
          >
            {current ? (
              <TicketReading id={current} poll={poll} onOpen={open} />
            ) : (
              <Reading
                title={t`No ticket selected`}
                body={t`Tickets appear here when ticket files or runs cross-repo work.`}
              />
            )}
          </div>
        </div>
      </div>
    )
  }

  if (id) {
    return (
      <div className="grid content-start gap-3">
        {/* the header of every pushed page: ‹, the page name, the link chip
            (it was a lone 「‹ 返回」 line above the ticket) */}
        <div className="-ml-2 flex items-center gap-1 pt-1">
          <BackButton onClick={back} label={t`Back`} />
          <h1 className="min-w-0 flex-1 truncate text-heading font-semibold">
            {t`Tickets`}
          </h1>
          <RemoteBadge compact />
        </div>
        <TicketReading id={id} poll={poll} onOpen={open} />
      </div>
    )
  }

  return (
    <div className="grid content-start gap-3">
      {top}
      {keys}
      {searching || query || fixedFilter ? (
        <SearchBox value={query} onChange={setQuery} autoFocus={searching} />
      ) : null}
      {/* "updated HH:MM" only when it matters: the host is unreachable */}
      {list.isError ? freshness : null}
      <TicketKeys
        tickets={recent}
        older={older}
        empty={emptyText}
        base={base}
      />
    </div>
  )
}

/** j / k: the next / previous ticket in the list (wide split), like 会话 */
function TicketListKeys({
  ids,
  current,
  onGo,
}: {
  ids: Array<string>
  current: string
  onGo: (id: string) => void
}) {
  const key = ids.join(' ')
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        (event.key !== 'j' && event.key !== 'k') ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.closest('input, textarea, select, [contenteditable="true"]') ||
        // a sheet (新工单) is open: the keys belong to it
        document.querySelector('[role="dialog"]')
      )
        return
      const next = nextInCycle(
        key.split(' '),
        current,
        event.key === 'j' ? 1 : -1,
      )
      if (!next) return
      event.preventDefault()
      onGo(next)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [key, current, onGo])
  return null
}

/** who holds the ticket now, in words (the CLI's owner field) */
export function useOwnerLabel() {
  const { t } = useLingui()
  const owners: Partial<Record<string, string>> = {
    initiator: t`Initiator`,
    worker: t`Headless worker`,
    human: t`A person (taken over)`,
  }
  return (owner?: string | null) => (owner ? (owners[owner] ?? owner) : '—')
}

export function RepoRoute({
  from,
  to,
}: {
  from?: string | null
  to?: string | null
}) {
  const tag =
    'max-w-full truncate rounded-full border border-brand-edge px-2 py-0.5 text-meta text-brand-muted'
  return (
    <span className="inline-flex max-w-full min-w-0 flex-wrap items-center gap-1">
      <span className={tag}>{from ?? '?'}</span>
      <span aria-hidden className="text-brand-label">
        →
      </span>
      <span className={tag}>{to ?? '?'}</span>
    </span>
  )
}

/** 待处理 (the old inbox route): tickets waiting on you or failed */
export function ConsoleInboxPage() {
  const { t } = useLingui()
  return (
    <TicketsView
      base="inbox"
      filter="inbox"
      empty={t`Nothing is waiting on you. Replies and failed runs show up here.`}
      top={
        <h1 className="hidden text-body font-semibold md:block">
          {t`Waiting on you`}
        </h1>
      }
    />
  )
}
