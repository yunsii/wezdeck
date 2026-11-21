import { useLingui } from '@lingui/react/macro'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { Select } from '#/components/ui/select'
import { getCollab } from '#/lib/runtime-client'
import type {
  CollabShow,
  CollabMetrics,
  CollabRunSummary,
  CollabTicket,
} from '#/lib/runtime-contract'
import { cn } from '#/lib/utils'
import { useRuntimeData } from './console-data'
import { RunDetail } from './console-collab-run'
import { RemoteBadge } from './remote-badge'
import { num, pct, secs, usd } from './console-collab-format'
import { Inspector, Reading } from './inspector'
import type { InspectorItem } from './inspector'

const ACTIVE_POLL_MS = 2_000
const IDLE_POLL_MS = 30_000

function ticketTone(ticket: CollabTicket): InspectorItem['tone'] {
  if (ticket.running.length > 0) return 'running'
  switch (ticket.status) {
    case 'waiting_initiator':
    case 'waiting_target':
    case 'submitted':
      return 'waiting'
    case 'failed':
    case 'rejected':
      return 'error'
    case 'shipped':
    case 'closed':
      return 'done'
    default:
      return 'muted'
  }
}

export function ConsoleCollabPage() {
  const { t } = useLingui()
  const runtime = useRuntimeData()
  const [status, setStatus] = useState('')
  const [window, setWindow] = useState('24h')
  const health = useQuery({
    queryKey: ['runtime', 'collab', 'health'],
    queryFn: () => getCollab('health'),
    enabled: typeof globalThis.window !== 'undefined',
    refetchInterval: (query) =>
      (query.state.data?.running ?? 0) > 0 ? ACTIVE_POLL_MS : IDLE_POLL_MS,
  })
  const active = (health.data?.running ?? 0) > 0
  const poll = active ? ACTIVE_POLL_MS : IDLE_POLL_MS
  const list = useQuery({
    queryKey: ['runtime', 'collab', 'list', status, health.data?.seq_head],
    queryFn: () => getCollab('list', { limit: 100, status }),
    enabled: typeof globalThis.window !== 'undefined',
    refetchInterval: poll,
  })
  const metrics = useQuery({
    queryKey: ['runtime', 'collab', 'metrics', window, health.data?.seq_head],
    queryFn: () => getCollab('metrics', { window }),
    enabled: typeof globalThis.window !== 'undefined',
    refetchInterval: IDLE_POLL_MS,
  })
  const tickets = list.data?.tickets ?? []
  const items: Array<InspectorItem> = tickets.map((ticket) => ({
    id: ticket.id,
    name: ticket.title || ticket.id,
    detail: `${ticket.from ?? '?'} → ${ticket.to ?? '?'} · ${
      ticket.progress?.message ?? ticket.phase ?? ''
    }`,
    status: ticket.running.length > 0 ? t`running` : (ticket.status ?? ''),
    tone: ticketTone(ticket),
  }))
  const [selected, setSelected] = useState('')
  const current =
    items.find((item) => item.id === selected)?.id ?? items.at(0)?.id ?? ''
  const unavailable =
    health.data && !health.data.ok ? health.data.error?.message : undefined

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3">
      <MetricsBand
        metrics={metrics.data}
        health={health.data}
        window={window}
        onWindow={setWindow}
      />
      <Inspector
        label={t`Collab tickets`}
        empty={
          list.isPending
            ? t`Loading…`
            : unavailable
              ? t`Collab data unavailable: ${unavailable}`
              : runtime.connected
                ? t`No collab tickets yet`
                : t`Runtime is offline.`
        }
        items={items}
        selected={current}
        onSelect={setSelected}
        toolbar={
          <Select
            value={status}
            onValueChange={setStatus}
            aria-label={t`Status`}
            options={[
              { value: '', label: t`All statuses` },
              { value: 'submitted,in_progress', label: t`Active` },
              {
                value: 'waiting_initiator,waiting_target',
                label: t`Waiting`,
              },
              { value: 'shipped', label: 'shipped' },
              { value: 'closed,rejected,failed', label: t`Finished` },
            ]}
          />
        }
        reading={
          current ? (
            <TicketReading id={current} poll={poll} onOpen={setSelected} />
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

function MetricsBand({
  metrics,
  health,
  window,
  onWindow,
}: {
  metrics: CollabMetrics | undefined
  health:
    { running?: number; waiting_human?: number; tickets?: number } | undefined
  window: string
  onWindow: (value: string) => void
}) {
  const { t } = useLingui()
  const reuse: Partial<Record<string, { cache_hit_rate?: number | null }>> =
    metrics?.by_reuse ?? {}
  const facts = [
    { label: t`Running`, value: num(health?.running) },
    { label: t`Waiting on human`, value: num(health?.waiting_human) },
    { label: t`Runs`, value: num(metrics?.runs) },
    { label: t`Sessions`, value: num(metrics?.sessions) },
    { label: t`Turns`, value: num(metrics?.turns) },
    { label: t`Cache hit`, value: pct(metrics?.cache_hit_rate) },
    {
      label: t`Resume / fresh hit`,
      value: `${pct(reuse.resume?.cache_hit_rate)} / ${pct(reuse.fresh?.cache_hit_rate)}`,
    },
    { label: t`Cost`, value: usd(metrics?.cost_usd) },
    {
      label: t`Parallelism`,
      value:
        typeof metrics?.realized_parallelism === 'number'
          ? `${metrics.realized_parallelism}×`
          : '—',
    },
    { label: t`Wall p50`, value: secs(metrics?.wall_ms?.p50) },
    { label: t`Peak RSS`, value: `${num(metrics?.rss_peak_mb?.max, 1)} MB` },
  ]
  return (
    <section
      aria-label={t`Collab metrics`}
      className="grid gap-2 border border-brand-border bg-brand-surface p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h1 className="text-sm font-semibold">{t`Cross-repo collab`}</h1>
          <RemoteBadge />
        </div>
        <div className="w-32 shrink-0">
          <Select
            value={window}
            onValueChange={onWindow}
            aria-label={t`Metrics window`}
            options={['1h', '24h', '7d', '30d', 'all'].map((value) => ({
              value,
              label: value,
            }))}
          />
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-px bg-brand-border sm:grid-cols-5">
        {facts.map((fact) => (
          <div key={fact.label} className="bg-brand-deck px-3 py-2">
            <dt className="text-xs text-brand-label">{fact.label}</dt>
            <dd className="mt-1 truncate font-mono text-sm">{fact.value}</dd>
          </div>
        ))}
      </dl>
      {metrics && Object.keys(metrics.reuse_reasons).length > 0 ? (
        <p className="font-mono text-xs text-brand-muted">
          {t`reuse reasons`}:{' '}
          {Object.entries(metrics.reuse_reasons)
            .map(([key, value]) => `${key} ${value}`)
            .join(' · ')}
        </p>
      ) : null}
    </section>
  )
}

function TicketReading({
  id,
  poll,
  onOpen,
}: {
  id: string
  poll: number
  onOpen: (id: string) => void
}) {
  const { t } = useLingui()
  const show = useQuery({
    queryKey: ['runtime', 'collab', 'show', id],
    queryFn: () => getCollab('show', { id }),
    refetchInterval: poll,
  })
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
      kicker={`${ticket.status ?? '?'} · ${ticket.phase ?? ''}`}
      title={ticket.title || ticket.id}
      facts={[
        { label: t`Route`, value: `${ticket.from} → ${ticket.to}` },
        { label: t`Owner`, value: ticket.owner ?? '—' },
        { label: t`Progress`, value: ticket.progress?.message ?? '—' },
        { label: t`Worktree`, value: ticket.branch ?? ticket.worktree ?? '—' },
      ]}
    >
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
  if (runs.length === 0) {
    return (
      <p className="text-sm text-brand-muted">{t`No headless runs recorded for this ticket.`}</p>
    )
  }
  return (
    <div className="overflow-x-auto border border-brand-border">
      <table
        className="w-full text-left font-mono text-xs"
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
        className="w-full text-left font-mono text-xs"
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
      <h2 className="text-sm font-semibold">{t`Integration`}</h2>
      {Object.entries(integration).map(([repo, info]) => (
        <p key={repo} className="font-mono text-xs text-brand-muted">
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
