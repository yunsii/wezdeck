import { useLingui } from '@lingui/react/macro'
import { useState } from 'react'

import { Field, FieldList } from '#/components/ui/field'
import { useCollab } from '#/lib/collab-query'
import { useIsWide } from '#/lib/use-media'
import type {
  CollabShow,
  CollabRunSummary,
  CollabTicket,
} from '#/lib/runtime-contract'
import { cn } from '#/lib/utils'
import { RunDetail } from './console-collab-run'
import { CopyReference } from './ticket-copy-reference'
import { num, pct, secs, usd } from './console-collab-format'
import { Reading } from './inspector'
import type { LedTone } from '#/components/deck/led'
import { TicketsView, useOwnerLabel, useStatusLabel } from './tickets-view'
import { CollabTopBar } from './collab-top-bar'
import { CollabMetricsBand } from './collab-metrics'
import {
  TicketAttach,
  TicketReply,
  TicketSections,
  openQuestion,
} from './ticket-reply'
import { Led } from '#/components/deck/led'
import { Button } from '#/components/ui/button'

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
      top={<CollabTopBar band={<CollabMetricsBand />} />}
    />
  )
}

export function TicketReading({
  id,
  poll,
  onOpen,
}: {
  id: string
  poll: number
  onOpen: (id: string) => void
}) {
  const { t } = useLingui()
  const show = useCollab('show', { id }, { refetchInterval: poll })
  const statusLabel = useStatusLabel()
  // every hook before the early returns below (it sat after them: the
  // loading render and the loaded one ran a different number of hooks)
  const ownerLabel = useOwnerLabel()
  const [run, setRun] = useState('')
  const data = show.data
  if (!data) return <Reading title={t`Loading…`} />
  if (!data.ok || !data.ticket) {
    return (
      <Reading title={t`Ticket unavailable`} body={data.error?.message ?? ''} />
    )
  }
  const ticket = data.ticket
  const runs = data.runs
  const currentRun = runs.find((item) => item.run === run) ?? runs.at(-1)
  return (
    <Reading
      kicker={
        <span className="flex flex-wrap items-center gap-2">
          <Led tone={ticketTone(ticket)} size={13} />
          {/* the phase code (research_done …) only as a hint: the label says it */}
          <span className="font-medium" title={ticket.phase ?? undefined}>
            {statusLabel(ticket)}
          </span>
          {data.reference ? <CopyReference text={data.reference} /> : null}
        </span>
      }
      title={ticket.title || ticket.id}
    >
      <TicketFields
        fields={[
          [t`Route`, `${ticket.from ?? '?'} → ${ticket.to ?? '?'}`],
          [t`Owner`, ownerLabel(ticket.owner)],
          [t`Progress`, ticket.progress?.message ?? ''],
          [t`Worktree`, ticket.branch ?? ticket.worktree ?? ''],
          [t`Ticket`, ticket.id],
        ]}
      />
      {ticket.status === 'waiting_initiator' ? (
        <TicketReply
          id={ticket.id}
          question={openQuestion(data.sections)}
          questions={data.questions}
        />
      ) : null}
      <TicketAttach
        id={ticket.id}
        sessions={data.sessions}
        running={ticket.running.length > 0}
      />
      <TicketSections
        sections={data.sections}
        waiting={ticket.status === 'waiting_initiator'}
      />
      {data.children_detail.length > 0 ? (
        <ChildrenTable children={data.children_detail} onOpen={onOpen} />
      ) : null}
      {data.collab?.integration ? (
        <IntegrationSummary integration={data.collab.integration} />
      ) : null}
      <RunTable
        runs={runs}
        selected={currentRun?.run ?? ''}
        onSelect={setRun}
      />
      {currentRun ? <RunDetail run={currentRun.run} poll={poll} /> : null}
    </Reading>
  )
}

/** the ticket's facts as Field rows (tap to copy, like 会话信息); empty ones say nothing */
function TicketFields({ fields }: { fields: Array<[string, string]> }) {
  const shown = fields.filter(([, value]) => value && value !== '—')
  if (shown.length === 0) return null
  return (
    <FieldList>
      {shown.map(([label, value]) => (
        <Field key={label} label={label} value={value} />
      ))}
    </FieldList>
  )
}

/** Phone: one key per run, the four numbers that matter, tap to open its record below. */
function RunKeys({
  runs,
  selected,
  onSelect,
}: {
  runs: Array<CollabRunSummary>
  selected: string
  onSelect: (run: string) => void
}) {
  const { t } = useLingui()
  return (
    <ul aria-label={t`Runs`} className="grid gap-2">
      {runs.map((item) => {
        const active = item.run === selected
        const tone =
          item.exit == null ? 'running' : item.exit === 0 ? 'done' : 'error'
        return (
          <li key={item.run}>
            <Button
              variant="plain"
              type="button"
              aria-pressed={active}
              onClick={() => onSelect(item.run)}
              className={cn(
                'key-press grid w-full gap-2 rounded-xl border px-3.5 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand-running',
                active
                  ? 'border-brand-edge bg-brand-deck shadow-[var(--key-pressed)]'
                  : 'key',
              )}
            >
              <span className="flex items-center gap-2 text-body">
                <Led tone={tone} size={12} />
                <span className="font-medium">{item.phase ?? '—'}</span>
                <span className="text-brand-label">
                  {item.session?.reuse ?? ''}
                </span>
                <span className="ml-auto font-mono text-meta text-brand-label">
                  {item.run.slice(-6)}
                </span>
              </span>
              <dl className="grid grid-cols-4 gap-2 text-meta">
                {[
                  [t`Turns`, num(item.turns)],
                  [t`Cache hit`, pct(item.cache_hit_rate)],
                  [t`Cost`, usd(item.cost_usd)],
                  [t`Wall`, secs(item.wall_ms)],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-brand-label">{label}</dt>
                    <dd className="mt-0.5 text-body text-brand-text">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            </Button>
          </li>
        )
      })}
    </ul>
  )
}

function RunTable({
  runs,
  selected,
  onSelect,
}: {
  runs: Array<CollabRunSummary>
  selected: string
  onSelect: (run: string) => void
}) {
  const { t } = useLingui()
  const wide = useIsWide()
  if (runs.length === 0) {
    return (
      <p className="text-caption text-brand-muted">{t`No headless runs recorded for this ticket.`}</p>
    )
  }
  if (!wide)
    return <RunKeys runs={runs} selected={selected} onSelect={onSelect} />
  return (
    <div className="overflow-x-auto rounded-xl border border-brand-edge">
      <table
        className="w-full text-left font-mono text-meta"
        aria-label={t`Runs`}
      >
        <thead className="bg-brand-deck text-brand-label">
          <tr>
            {[
              t`Run`,
              t`Phase`,
              t`Session`,
              t`Turns`,
              t`Cache hit`,
              t`Cost`,
              t`Wall`,
              t`RSS`,
              t`Exit`,
            ].map((head) => (
              <th key={head} className="px-2 py-1.5 font-normal">
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {runs.map((item) => (
            <tr
              key={item.run}
              tabIndex={0}
              aria-selected={item.run === selected}
              onClick={() => onSelect(item.run)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onSelect(item.run)
                }
              }}
              className={cn(
                'cursor-pointer border-t border-brand-border outline-none focus-visible:ring-2 focus-visible:ring-brand-running focus-visible:ring-inset',
                item.run === selected
                  ? 'bg-brand-soft'
                  : 'hover:bg-brand-soft/60',
              )}
            >
              <td className="px-2 py-1.5">{item.run.slice(-6)}</td>
              <td className="px-2 py-1.5">{item.phase ?? '—'}</td>
              <td className="px-2 py-1.5">
                {item.session?.reuse ?? '—'}
                {item.session?.reason ? ` · ${item.session.reason}` : ''}
              </td>
              <td className="px-2 py-1.5">{num(item.turns)}</td>
              <td className="px-2 py-1.5">{pct(item.cache_hit_rate)}</td>
              <td className="px-2 py-1.5">{usd(item.cost_usd)}</td>
              <td className="px-2 py-1.5">{secs(item.wall_ms)}</td>
              <td className="px-2 py-1.5">{num(item.rss_peak_mb)}</td>
              <td
                className={cn(
                  'px-2 py-1.5',
                  item.exit !== 0 && item.exit != null && 'text-brand-error',
                )}
              >
                {item.exit ?? '…'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
  const byId = new Map(children.map((child) => [child.id, child]))
  return (
    <div className="overflow-x-auto border border-brand-border">
      <table
        className="w-full text-left font-mono text-meta"
        aria-label={t`Children`}
      >
        <thead className="bg-brand-deck text-brand-label">
          <tr>
            {[
              t`Child`,
              t`Repo`,
              t`Status`,
              t`Depends on`,
              t`Scope`,
              t`Cache hit`,
            ].map((head) => (
              <th key={head} className="px-2 py-1.5 font-normal">
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {children.map((child) => (
            <tr
              key={child.id}
              tabIndex={0}
              onClick={() => onOpen(child.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  onOpen(child.id)
                }
              }}
              className="cursor-pointer border-t border-brand-border outline-none hover:bg-brand-soft/60 focus-visible:ring-2 focus-visible:ring-brand-running focus-visible:ring-inset"
            >
              <td className="px-2 py-1.5">{child.title || child.id}</td>
              <td className="px-2 py-1.5">{child.to ?? '—'}</td>
              <td
                className={cn(
                  'px-2 py-1.5',
                  child.running.length > 0 && 'text-brand-running',
                  child.status === 'waiting_initiator' && 'text-brand-waiting',
                  child.status === 'failed' && 'text-brand-error',
                )}
              >
                {child.running.length > 0 ? t`running` : child.status}
              </td>
              <td className="px-2 py-1.5">
                {child.depends_on
                  .map((dep) => byId.get(dep)?.title ?? dep.slice(-6))
                  .join(', ') || '—'}
              </td>
              <td className="px-2 py-1.5">{child.scope.join(', ') || '*'}</td>
              <td className="px-2 py-1.5">
                {pct(child.last_run?.cache_hit_rate)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function IntegrationSummary({
  integration,
}: {
  integration: NonNullable<NonNullable<CollabShow['collab']>['integration']>
}) {
  const { t } = useLingui()
  return (
    <section aria-label={t`Integration`} className="grid gap-1">
      <h2 className="text-body font-semibold">{t`Integration`}</h2>
      {Object.entries(integration).map(([repo, info]) => (
        <p key={repo} className="font-mono text-meta text-brand-muted">
          {repo}:{' '}
          {info.conflict ? (
            <span className="text-brand-error">
              {t`conflict`} ({info.conflict.files.join(', ')})
            </span>
          ) : info.skipped ? (
            info.skipped
          ) : (
            `${t`merged`} ${info.merged.length} → ${info.branch ?? ''}`
          )}
        </p>
      ))}
    </section>
  )
}
