// Ticket detail reading view (aligned with SessionDetail): sticky TicketHeader
// (mobile back + status LED + tappable title + ⓘ TicketInfo sheet), first-screen
// decision/discussion body (proposals / reply, summary & thread, children,
// integration), and compact flat run rows that open RunDetail in a sheet.
import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ChevronRight } from 'lucide-react'
import { useLayoutEffect } from 'react'

import { BackButton } from '#/components/deck/back-button'
import { Led } from '#/components/deck/led'
import type { LedTone } from '#/components/deck/led'
import { Button } from '#/components/ui/button'
import { collabKey, useCollab } from '#/lib/collab-query'
import type { CollabShow, CollabTicket } from '#/lib/runtime-contract'
import { cn } from '#/lib/utils'
import { CollabMetricsBand } from './collab-metrics'
import { CollabTopBar } from './collab-top-bar'
import { pct } from './console-collab-format'
import { Reading } from './inspector'
import { TicketDeliveryCard } from './ticket-delivery-card'
import { TicketHeader } from './ticket-header'
import { TicketManagerPanel } from './ticket-manager-panel'
import { TicketPipeline, useGateLabel } from './ticket-pipeline'
import { TicketProposals } from './ticket-proposals'
import { TicketReply, TicketSections, openQuestion } from './ticket-reply'
import { TicketRunChat } from './ticket-run-chat'
import { TicketRuns } from './ticket-runs'
import { TicketTimeline } from './ticket-timeline'
import { TicketsView } from './tickets-view'

export function ticketTone(ticket: CollabTicket): LedTone {
  if (ticket.running.length > 0) return 'running'
  switch (ticket.status) {
    // ▲ only where you are the one to act; waiting on the other side is a
    // calm ○, or 已提交 and 等你 looked the same at a glance
    case 'waiting_initiator':
      return 'waiting'
    case 'waiting_target':
    case 'submitted':
      return 'muted'
    case 'failed':
    case 'rejected':
      return 'error'
    case 'in_progress':
      return 'running'
    case 'shipped':
      return 'done'
    default:
      // closed (abandoned / superseded) and unknown states: an unlit key
      return 'muted'
  }
}

export function ConsoleCollabPage() {
  const { t } = useLingui()
  return (
    <TicketsView
      base="collab"
      empty={t`No tickets match this filter.`}
      top={(search) => (
        <CollabTopBar band={<CollabMetricsBand />} search={search} />
      )}
    />
  )
}

export function TicketReading({
  id,
  poll,
  onOpen,
  onBack,
}: {
  id: string
  poll: number
  onOpen: (id: string) => void
  onBack?: () => void
}) {
  const { t } = useLingui()
  const client = useQueryClient()
  const peek = client.getQueryData<CollabShow>(collabKey('show', { id }))
  const peekLive = Boolean(
    peek?.ok &&
    ((peek.ticket?.running.length ?? 0) > 0 ||
      peek.collab?.scheduler?.alive ||
      peek.children_detail.some((item) => item.running.length > 0)),
  )
  // switching tickets keeps the last one on screen until the next arrives:
  // a Loading… heading for ~50 ms between them read as a flash
  const show = useCollab(
    'show',
    { id },
    {
      refetchInterval: peekLive ? Math.min(poll, 2_000) : poll,
      keepPrevious: true,
    },
  )
  // another ticket starts at its top, before it paints (the router no
  // longer restores a detail page's scroll: view-transition.ts)
  useLayoutEffect(() => {
    ;(
      document.querySelector('.vt-split-pane.overflow-y-auto') ??
      document.querySelector('.vt-page')
    )?.scrollTo({ top: 0 })
  }, [id])
  const data = show.data
  if (!data || !data.ok || !data.ticket) {
    return (
      <div className="grid content-start gap-3">
        {onBack ? (
          <div className="sticky top-0 z-30 -mx-[var(--page-x)] flex items-center gap-1 border-b border-brand-edge bg-brand-deck px-[var(--page-x)] pt-[max(env(safe-area-inset-top),0.375rem)] pb-2 md:hidden">
            <BackButton onClick={onBack} label={t`Back`} className="-ml-2" />
            <span className="truncate text-body font-semibold text-brand-text">
              {t`Tickets`}
            </span>
          </div>
        ) : null}
        <Reading
          title={!data ? t`Loading…` : t`Ticket unavailable`}
          body={data ? (data.error?.message ?? '') : undefined}
        />
      </div>
    )
  }
  const ticket = data.ticket
  const isLive =
    ticket.running.length > 0 ||
    Boolean(data.collab?.scheduler?.alive) ||
    data.children_detail.some((item) => item.running.length > 0)
  const livePoll = isLive ? Math.min(poll, 2_000) : poll
  const childTitle = (child: string) =>
    data.children_detail.find((item) => item.id === child)?.title ?? undefined

  return (
    // the previous ticket, held while this one loads: not actionable
    <div
      inert={show.isPlaceholderData}
      aria-busy={show.isPlaceholderData}
      className="grid content-start"
    >
      <TicketHeader data={data} onBack={onBack} />
      <div className="grid max-w-4xl min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-4 pt-3 pb-4">
        {ticket.parent ? (
          <div>
            <Button
              variant="ghost"
              size="none"
              type="button"
              data-testid="ticket-parent-back"
              onClick={() => onOpen(ticket.parent!)}
              className="inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2.5 text-caption text-brand-muted hover:text-brand-text"
            >
              <ArrowLeft size={14} aria-hidden />
              <span>{t`Back to parent ticket`}</span>
            </Button>
          </div>
        ) : null}
        <TicketPipeline data={data} />
        <TicketManagerPanel ticket={ticket} poll={livePoll} />
        <TicketProposals
          id={ticket.id}
          proposals={data.proposals}
          childTitle={childTitle}
        />
        {/* a parent parked on proposals answers them above, not with free text */}
        {ticket.status === 'waiting_initiator' &&
        data.proposals.length === 0 ? (
          <TicketReply
            id={ticket.id}
            question={openQuestion(data.sections)}
            questions={data.questions}
          />
        ) : null}
        <TicketSections
          sections={data.sections}
          waiting={ticket.status === 'waiting_initiator'}
        />
        {data.children_detail.length > 0 ? (
          <ChildrenTable children={data.children_detail} onOpen={onOpen} />
        ) : null}
        {data.collab?.integration ? (
          <TicketDeliveryCard data={{ ...data, ticket }} />
        ) : null}
        {data.runs.length > 0 || ticket.running.length > 0 ? (
          <TicketRunChat
            ticketId={ticket.id}
            runs={data.runs}
            liveRunIds={ticket.running}
            poll={livePoll}
          />
        ) : null}
        <TicketRuns runs={data.runs} poll={livePoll} />
        <TicketTimeline
          id={ticket.id}
          active={isLive}
          poll={livePoll}
          childTitle={childTitle}
        />
      </div>
    </div>
  )
}

type CollabChild = CollabShow['children_detail'][number]

function ChildrenTable({
  children,
  onOpen,
}: {
  children: Array<CollabChild>
  onOpen: (id: string) => void
}) {
  const { t } = useLingui()
  const gateLabel = useGateLabel()
  const byId = new Map(children.map((child) => [child.id, child]))
  const doneCount = children.filter(
    (c) => c.status === 'shipped' || c.status === 'closed',
  ).length
  const runningCount = children.filter((c) => c.running.length > 0).length
  const queuedCount = children.filter(
    (c) => c.running.length === 0 && Boolean(c.gate?.gate),
  ).length
  const waitingCount = children.filter(
    (c) => c.status === 'waiting_initiator',
  ).length
  const totalCount = children.length

  return (
    <section className="grid gap-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-1 text-meta text-brand-label tabular-nums">
        <span className="font-semibold text-brand-text">
          {t`Children`} {doneCount}/{totalCount}
        </span>
        {runningCount > 0 ? (
          <span className="text-brand-running">{t`${runningCount} running`}</span>
        ) : null}
        {queuedCount > 0 ? <span>{t`${queuedCount} queued`}</span> : null}
        {waitingCount > 0 ? (
          <span className="text-brand-waiting">
            {t`${waitingCount} waiting`}
          </span>
        ) : null}
      </div>
      <ul
        aria-label={t`Children`}
        data-testid="ticket-children-list"
        className="ticket-list overflow-hidden rounded-xl border border-brand-edge bg-brand-surface"
      >
        {children.map((child) => {
          const tone = ticketTone(child)
          const isRunning = child.running.length > 0
          const gateText =
            !isRunning && child.gate?.gate
              ? gateLabel(child.gate.gate, child.gate.detail)
              : ''
          const note =
            child.last_milestone?.text ?? child.progress?.message ?? ''
          const statusText = isRunning
            ? child.phase
              ? `${t`running`} · ${child.phase}`
              : t`running`
            : gateText
              ? gateText
              : (child.status ?? '—')
          const depsText = child.depends_on
            .map((dep) => byId.get(dep)?.title ?? dep.slice(-6))
            .join(', ')
          const scopes = child.scope.slice(0, 2)
          const extraScopes = Math.max(0, child.scope.length - scopes.length)
          const hitText = pct(child.last_run?.cache_hit_rate)
          return (
            <li key={child.id}>
              <Button
                variant="plain"
                size="none"
                type="button"
                onClick={() => onOpen(child.id)}
                className="list-row grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2.5 gap-y-1 px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand-running focus-visible:ring-inset"
              >
                <span className="pt-1.5">
                  <Led tone={tone} size={10} />
                </span>
                <span className="grid min-w-0 gap-1">
                  <span className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                    <span className="min-w-0 text-body leading-snug font-medium text-brand-text">
                      {child.title || child.id}
                    </span>
                    <span
                      className={cn(
                        'shrink-0 text-meta font-medium',
                        isRunning && 'text-brand-running',
                        child.status === 'waiting_initiator' &&
                          'text-brand-waiting',
                        child.status === 'failed' && 'text-brand-error',
                        child.status === 'shipped' && 'text-brand-done',
                        !isRunning &&
                          child.status !== 'waiting_initiator' &&
                          child.status !== 'failed' &&
                          child.status !== 'shipped' &&
                          'text-brand-label',
                      )}
                    >
                      {statusText}
                    </span>
                  </span>
                  <span className="flex min-w-0 flex-wrap items-center gap-1.5 font-mono text-meta text-brand-muted">
                    {child.to ? (
                      <span className="rounded-full border border-brand-edge px-2 py-0.5 text-brand-muted">
                        {child.to}
                      </span>
                    ) : null}
                    {scopes.map((s) => (
                      <span
                        key={s}
                        className="max-w-[14rem] truncate rounded-md bg-brand-deck px-1.5 py-0.5 text-brand-label"
                        title={s}
                      >
                        {s}
                      </span>
                    ))}
                    {extraScopes > 0 ? (
                      <span className="text-brand-label">+{extraScopes}</span>
                    ) : null}
                    {hitText && hitText !== '—' ? (
                      <span className="text-brand-label tabular-nums">
                        {t`Cache hit`} {hitText}
                      </span>
                    ) : null}
                  </span>
                  {depsText ? (
                    <span className="truncate text-meta text-brand-label">
                      {t`Depends on`}: {depsText}
                    </span>
                  ) : null}
                  {note ? (
                    <span
                      className="line-clamp-2 text-caption text-brand-muted"
                      title={note}
                    >
                      {note}
                    </span>
                  ) : null}
                </span>
                <span className="pt-1 text-brand-label">
                  <ChevronRight size={15} aria-hidden />
                </span>
              </Button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
