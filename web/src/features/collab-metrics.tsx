// 工单 › 运行、缓存与花费: the `ticket api metrics` band. A window and a repo
// filter (from / to, like fe1's 只看 fe1 相关, here over every repo the
// ticket list knows); the headline cells; then the breakdowns the API
// already returns — by target repo, backend, session reuse, trigger, and the
// initial prompt size per phase — folded, so the band stays one glance.
import { useLingui } from '@lingui/react/macro'
import { useState } from 'react'

import { Disclosure } from '#/components/ui/disclosure'
import { Select } from '#/components/ui/select'
import { useCollab } from '#/lib/collab-query'
import type { CollabMetrics } from '#/lib/runtime-contract'
import { useTicketHealth, useTicketList } from '#/lib/ticket-sync'
import { num, pct, secs, usd } from './console-collab-format'

const ALL = '*'

/** 6,279,462 → 6.3M: the four-way token split fits one cell */
const compact = (value: number | null | undefined) =>
  typeof value === 'number'
    ? new Intl.NumberFormat('en', {
        notation: 'compact',
        maximumFractionDigits: 1,
      }).format(value)
    : '—'

type Group = Record<
  string,
  { runs: number; cache_hit_rate?: number | null; cost_usd?: number | null }
>

/** repos seen on either end of a ticket, for the filter */
function useRepos() {
  const list = useTicketList()
  const seen = new Set<string>()
  for (const ticket of list.data?.tickets ?? []) {
    if (ticket.from) seen.add(ticket.from)
    if (ticket.to) seen.add(ticket.to)
  }
  return [...seen].sort()
}

export function CollabMetricsBand() {
  const { t } = useLingui()
  const [window, setWindow] = useState('24h')
  const [repo, setRepo] = useState(ALL)
  const scoped = repo === ALL ? undefined : repo
  const repos = useRepos()
  const allHealth = useTicketHealth()
  const repoHealth = useCollab(
    'health',
    { repo: scoped },
    { enabled: !!scoped, refetchInterval: 30_000 },
  )
  const health = scoped ? repoHealth.data : allHealth.data
  const metrics = useCollab(
    'metrics',
    { window, repo: scoped },
    { refetchInterval: 30_000 },
  ).data
  return (
    <section
      aria-label={t`Collab metrics`}
      className="grid gap-2 rounded-2xl border border-brand-edge bg-brand-surface p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-body font-semibold">{t`Cross-repo collab`}</h1>
        <div className="flex gap-2">
          <div className="w-36 shrink-0">
            <Select
              value={repo}
              onValueChange={(value) => setRepo(value || ALL)}
              aria-label={t`Repo filter`}
              options={[
                { value: ALL, label: t`All repos` },
                ...repos.map((value) => ({ value, label: value })),
              ]}
            />
          </div>
          <div className="w-24 shrink-0">
            <Select
              value={window}
              onValueChange={setWindow}
              aria-label={t`Metrics window`}
              options={['1h', '24h', '7d', '30d', 'all'].map((value) => ({
                value,
                label: value,
              }))}
            />
          </div>
        </div>
      </div>
      <Headline metrics={metrics} health={health} />
      {metrics && Object.keys(metrics.reuse_reasons).length > 0 ? (
        <p className="font-mono text-meta text-brand-muted">
          {t`reuse reasons`}:{' '}
          {Object.entries(metrics.reuse_reasons)
            .map(([key, value]) => `${key} ${value}`)
            .join(' · ')}
        </p>
      ) : null}
      {metrics && metrics.runs > 0 ? <Breakdowns metrics={metrics} /> : null}
    </section>
  )
}

function Headline({
  metrics,
  health,
}: {
  metrics: CollabMetrics | undefined
  health: { running?: number; waiting_human?: number } | undefined
}) {
  const { t } = useLingui()
  const reuse: Partial<Record<string, { cache_hit_rate?: number | null }>> =
    metrics?.by_reuse ?? {}
  const tokens = metrics?.tokens
  const tokenSum = tokens
    ? (tokens.input ?? 0) +
      (tokens.cache_read ?? 0) +
      (tokens.cache_write ?? 0) +
      (tokens.output ?? 0)
    : undefined
  const facts = [
    { label: t`Running`, value: num(health?.running) },
    { label: t`Waiting on human`, value: num(health?.waiting_human) },
    { label: t`Runs`, value: num(metrics?.runs) },
    { label: t`Failed runs`, value: num(metrics?.failed_runs) },
    { label: t`Sessions`, value: num(metrics?.sessions) },
    { label: t`Turns`, value: num(metrics?.turns) },
    { label: t`Tokens`, value: num(tokenSum) },
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
    {
      label: t`Wall p50 / p95`,
      value: `${secs(metrics?.wall_ms?.p50)} / ${secs(metrics?.wall_ms?.p95)}`,
    },
    { label: t`Wall total`, value: secs(metrics?.wall_ms?.sum) },
    {
      label: t`RSS p95 / peak`,
      value: `${num(metrics?.rss_peak_mb?.p95, 1)} / ${num(metrics?.rss_peak_mb?.max, 1)} MB`,
    },
    {
      label: t`Tokens in / cache r / cache w / out`,
      value: tokens
        ? [tokens.input, tokens.cache_read, tokens.cache_write, tokens.output]
            .map(compact)
            .join(' / ')
        : '—',
    },
  ]
  return (
    <dl className="grid grid-cols-2 overflow-hidden rounded-xl border-t border-l border-brand-edge sm:grid-cols-5">
      {facts.map((fact) => (
        <div
          key={fact.label}
          className="border-r border-b border-brand-edge bg-brand-key px-3 py-2"
        >
          <dt className="text-meta text-brand-label">{fact.label}</dt>
          <dd className="mt-1 truncate text-body" title={fact.value}>
            {fact.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function Breakdowns({ metrics }: { metrics: CollabMetrics }) {
  const { t } = useLingui()
  const phases = Object.entries(metrics.prompt_est_tokens_by_phase)
  const triggers = Object.entries(metrics.by_trigger).sort(
    (a, b) => b[1] - a[1],
  )
  return (
    <Disclosure
      className="px-1"
      triggerClassName="text-caption font-normal text-brand-muted"
      title={t`Breakdowns`}
    >
      <div className="grid items-start gap-3 pb-1 md:grid-cols-2">
        <GroupTable title={t`By target repo`} group={metrics.by_repo} />
        <GroupTable title={t`By backend`} group={metrics.by_backend} />
        <GroupTable title={t`By session reuse`} group={metrics.by_reuse} />
        {triggers.length > 0 ? (
          <Table
            title={t`By trigger`}
            head={[t`Trigger`, t`Runs`]}
            rows={triggers.map(([key, runs]) => [key, num(runs)])}
          />
        ) : null}
        {phases.length > 0 ? (
          <Table
            title={t`Initial prompt by phase (est. tokens)`}
            head={[t`Phase`, t`Runs`, 'p50', 'max']}
            rows={phases.map(([phase, stat]) => [
              phase,
              num(stat.n),
              num(stat.p50),
              num(stat.max),
            ])}
          />
        ) : null}
      </div>
    </Disclosure>
  )
}

function GroupTable({ title, group }: { title: string; group: Group }) {
  const { t } = useLingui()
  const rows = Object.entries(group).sort((a, b) => b[1].runs - a[1].runs)
  if (rows.length === 0) return null
  return (
    <Table
      title={title}
      head={[t`Name`, t`Runs`, t`Cache hit`, t`Cost`]}
      rows={rows.map(([key, value]) => [
        key,
        num(value.runs),
        pct(value.cache_hit_rate),
        usd(value.cost_usd),
      ])}
    />
  )
}

function Table({
  title,
  head,
  rows,
}: {
  title: string
  head: Array<string>
  rows: Array<Array<string>>
}) {
  return (
    <table aria-label={title} className="w-full table-fixed text-meta">
      <caption className="pb-1 text-left text-caption font-medium text-brand-text">
        {title}
      </caption>
      <thead className="text-left text-brand-label">
        <tr>
          {head.map((cell, i) => (
            <th
              key={cell}
              className={
                i
                  ? 'px-2 py-1 text-right font-normal'
                  : 'w-[40%] py-1 font-normal'
              }
            >
              {cell}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row[0]} className="border-t border-brand-edge">
            {row.map((cell, i) => (
              <td
                key={i}
                className={
                  i
                    ? 'px-2 py-1 text-right font-mono tabular-nums'
                    : 'truncate py-1 font-mono'
                }
                title={i ? undefined : cell}
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
