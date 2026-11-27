// Ticket list + detail for the collab sections (docs/web-pwa.md):
// - wide (≥768px): a split like 会话 (sticky list + ticket), selection lives in the URL
//   (/console/<base>/$id, replace) so j/k / arrows / clicks are deep-linkable;
// - phone: a deck of ticket keys; a key pushes /console/<base>/$id (full
//   page, back returns via history like a native app).
// All sections share one "all tickets" read and filter on the client, so
// switching tabs costs no request and the status keys can show counts.
import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'

import { Led } from '#/components/deck/led'
import { Segmented } from '#/components/deck/segmented'
import { SplitColumn } from '#/components/deck/split-column'
import { StickyBar } from '#/components/deck/sticky-bar'
import { useGoBack } from '#/lib/go-back'
import {
  RememberOpened,
  idInUrl,
  pickLast,
  useStoredChoice,
} from '#/lib/last-opened'
import { useLocale } from '#/lib/locale-context'
import type { CollabTicket } from '#/lib/runtime-contract'
import { useTicketHealth, useTicketList } from '#/lib/ticket-sync'
import { useIsWide } from '#/lib/use-media'
import { cn } from '#/lib/utils'
import { TicketReading } from './console-collab'
import { useRemoteState } from './console-mode'
import { CopyKey, useCopyTicketReference } from './copy-reference'
import { Reading } from './inspector'
import { nextInCycle } from './session-order'
import { prefetchTicket } from './ticket-autosync'
import { TicketKeys } from './ticket-keys'
import { SearchBox } from './ticket-search'

const ACTIVE_POLL_MS = 2_000
const IDLE_POLL_MS = 30_000

/** Segments on the tickets page; `inbox` is the old 待处理 route's fixed filter. */
export type TicketFilter = 'all' | 'active' | 'mine' | 'ended' | 'inbox'

const ENDED = new Set(['shipped', 'closed', 'failed', 'rejected'])

const FILTERS: Record<TicketFilter, (t: CollabTicket) => boolean> = {
  all: () => true,
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

// one formatter per locale: building an Intl.RelativeTimeFormat per row was
// the top app cost of a ticket switch (every row re-renders) in a profile
const formats = new Map<string, Intl.RelativeTimeFormat>()
const relativeFormat = (locale: string) => {
  let format = formats.get(locale)
  if (!format) {
    format = new Intl.RelativeTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', {
      numeric: 'auto',
      style: 'short',
    })
    formats.set(locale, format)
  }
  return format
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
  const format = relativeFormat(locale)
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
          ? 'border-l-[3px] border-brand-waiting bg-brand-waiting/10 px-3 py-2 text-brand-text'
          : 'text-brand-label',
      )}
    >
      {stale ? <Led tone="waiting" size={11} /> : null}
      {stale ? `${reason}，${t`data as of ${time}`}` : t`Updated ${time}`}
    </p>
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
  const everything = count('all')
  const active = count('active')
  const mine = count('mine')
  const ended = count('ended')
  return (
    <Segmented
      label={t`Status`}
      value={value}
      onChange={onChange}
      className="md:max-w-md"
      // four segments beside two buttons on a phone (as 会话's filter):
      // without it the row outgrew a 360 px screen
      dense
      options={[
        {
          value: 'all',
          label: t({ message: 'All', context: 'filter' }),
          count: everything,
        },
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
  top: topSlot,
  empty,
}: {
  base: 'collab' | 'inbox'
  /** fixed filter (inbox); omitted = status keys */
  filter?: TicketFilter
  /** the page head; a function gets the phone's list actions (search,
   * new ticket) to place in it, else they sit beside the filter */
  top?: React.ReactNode | ((actions: React.ReactNode) => React.ReactNode)
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
  const copyReference = useCopyTicketReference()
  // kept per browser like 会话's (lib/last-opened.ts)
  const [chosen, setChosen] = useStoredChoice<TicketFilter>(
    `wezdeck-ticket-filter-${base}`,
    'active',
    (value) => value in FILTERS && value !== 'inbox',
  )
  const filter = fixedFilter ?? chosen
  const [query, setQuery] = useState('')
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
  const searchBox = <SearchBox value={query} onChange={setQuery} />
  const searchInTop = typeof topSlot === 'function'
  const top = searchInTop ? topSlot(searchBox) : topSlot
  const keys = fixedFilter ? null : (
    <StatusSegments tickets={all} value={chosen} onChange={setChosen} />
  )

  const { recent, older } =
    (filter === 'active' || filter === 'all') && !needle
      ? splitQuiet(tickets)
      : { recent: tickets, older: [] }

  // no ticket in the URL (wide): the one last opened under this filter, else
  // the one last opened at all if it still exists (switching to 全部), else
  // the top of the list (lib/last-opened.ts pickLast)
  const lastKey = `wezdeck-last-ticket-${base}`
  const pick =
    id || !all.length
      ? {}
      : pickLast(
          lastKey,
          filter,
          tickets.map((ticket) => ticket.id),
          all.map((ticket) => ticket.id),
        )
  const toAll = wide && Boolean(pick.all) && !fixedFilter && chosen !== 'all'
  // held once picked (until a ticket is in the URL): switching to 全部 must
  // not re-pick 全部's own last
  const held = useRef<string | undefined>(undefined)
  if (id) held.current = undefined
  else if (pick.id && !held.current) held.current = pick.id
  useEffect(() => {
    if (toAll) setChosen('all')
    // setChosen is a fresh closure; toAll decides
  }, [toAll])

  if (wide) {
    // a split like 会话 (session-split.tsx): the list sticky on the left, the
    // ticket beside it in the page scroll, j / k move through the list
    const current =
      id ?? held.current ?? recent.at(0)?.id ?? older.at(0)?.id ?? ''
    return (
      <div className="grid grid-cols-[minmax(300px,360px)_minmax(0,1fr)] items-stretch">
        <TicketListKeys
          ids={[...recent, ...older].map((ticket) => ticket.id)}
          current={current}
          onGo={(next) => open(next, true)}
        />
        <CopyKey id={current} copy={copyReference} />
        <RememberOpened storageKey={lastKey} id={current} filter={filter} />
        <SplitColumn
          label={t`Collab tickets`}
          className="bg-brand-surface [--split-pad:0.75rem]"
          head={
            <>
              {top}
              {list.isError ? freshness : null}
              {keys}
              {searchBox}
            </>
          }
        >
          <TicketKeys
            tickets={recent}
            older={older}
            empty={emptyText}
            base={base}
            selected={current}
          />
        </SplitColumn>
        {/* flat like 会话's pane: the divider is its left edge, page tall */}
        <div
          className="vt-split-pane min-h-[100cqh] min-w-0 border-l border-brand-edge px-[var(--page-x)]"
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
    )
  }

  if (id) {
    return <TicketReading id={id} poll={poll} onOpen={open} onBack={back} />
  }

  return (
    <div className="flex min-h-full w-full flex-1 flex-col bg-brand-surface">
      <h1 className="sr-only">
        {base === 'inbox' ? t`Waiting on you` : t`Cross-repo collab`}
      </h1>
      <StickyBar className="top-0 mx-0 my-0 grid gap-2 border-b border-brand-edge bg-brand-surface/95 px-3 pt-[max(env(safe-area-inset-top),0.5rem)] pb-2">
        {searchInTop ? (
          top
        ) : (
          <div className="flex min-w-0 items-center gap-1.5">{searchBox}</div>
        )}
        {keys}
      </StickyBar>
      {/* "updated HH:MM" only when it matters: the host is unreachable */}
      {list.isError ? (
        <div className="border-b border-brand-edge">{freshness}</div>
      ) : null}
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
  const client = useQueryClient()
  // warm neighbors so j / k stepping opens from cache without waiting
  useEffect(() => {
    if (!current || ids.length < 2) return
    const next = nextInCycle(ids, current, 1)
    const prev = nextInCycle(ids, current, -1)
    if (next) prefetchTicket(client, next)
    if (prev && prev !== next) prefetchTicket(client, prev)
  }, [client, ids, current])
  // read at the keypress, the URL first (idInUrl): the page re-renders only
  // after the switch's view transition
  const now = useRef({ ids, current, onGo })
  now.current = { ids, current, onGo }
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
      const { ids: list, current: at, onGo: go } = now.current
      const fromUrl = idInUrl('collab') || idInUrl('inbox')
      const next = nextInCycle(list, fromUrl || at, event.key === 'j' ? 1 : -1)
      if (!next) return
      event.preventDefault()
      go(next)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
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
