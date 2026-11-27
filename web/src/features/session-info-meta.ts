// Pure projection helpers for 会话信息 (session-info.tsx): distills host
// `meta`, `usage`, `account`, and `capabilities` into a compact first-screen
// overview + usage summary while keeping every raw field intact for the
// collapsible Technical details panel.
import type { Detail } from './console-sessions'
import { formatTokenRate, formatTtft } from '#/lib/turn-progress'

export type MetaRow = { key: string; value: string }
export type MetaGroup = { name: string; rows: Array<MetaRow> }

const TIME_KEYS = new Set([
  'modified',
  'first_turn',
  'last_turn',
  'status_updated',
])

export function formatMetaValue(key: string, value: string): string {
  if (TIME_KEYS.has(key)) {
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) return date.toLocaleString()
  }
  if (key === 'bytes') {
    const n = Number(value)
    if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
    if (n >= 1024) return `${Math.round(n / 1024)} KB`
  }
  return value
}

export function metaValue(data: Detail, key: string): string {
  for (const group of data.meta ?? [])
    for (const row of group.rows) if (row.key === key) return row.value
  return ''
}

/** First-screen overview rows: status (+ mode), model (+ effort), directory. */
export function buildOverviewRows(
  data: Detail,
  statusLabel: string,
): Array<MetaRow> {
  const rows: Array<MetaRow> = []
  const mode = data.mode || metaValue(data, 'mode')
  const stateLine = [statusLabel, mode].filter(Boolean).join(' · ')
  if (stateLine) rows.push({ key: 'status', value: stateLine })

  const model = data.usage?.model || metaValue(data, 'model')
  const effort = metaValue(data, 'effort')
  const modelLine = [model, effort].filter(Boolean).join(' · ')
  if (modelLine) rows.push({ key: 'model', value: modelLine })

  const cwd = metaValue(data, 'cwd')
  if (cwd) rows.push({ key: 'cwd', value: cwd })
  return rows
}

/** First-screen compact usage rows: context, output+rate+cache, account limits. */
export function buildUsageSummaryRows(
  data: Detail,
  labels: { compacted: string; cache: string },
): Array<MetaRow> {
  const rows: Array<MetaRow> = []
  const u = data.usage
  if (u?.context_limit) {
    rows.push({
      key: 'context',
      value: u.context_pending
        ? labels.compacted
        : `${u.context.toLocaleString()} / ${u.context_limit.toLocaleString()} (${Math.round((u.context / u.context_limit) * 100)}%)`,
    })
  }
  const outputParts: Array<string> = []
  if (u?.output) outputParts.push(u.output.toLocaleString())
  if (data.token_rate && data.token_rate.tok_per_s > 0) {
    outputParts.push(formatTokenRate(data.token_rate.tok_per_s))
  }
  if (u && u.input + u.cache_read > 0) {
    const pct = Math.round((u.cache_read / (u.input + u.cache_read)) * 100)
    outputParts.push(`${labels.cache} ${pct}%`)
  }
  if (outputParts.length) {
    rows.push({ key: 'output', value: outputParts.join(' · ') })
  }
  const limits: Array<string> = []
  if (data.account?.five_hour) {
    limits.push(`5h ${data.account.five_hour.used_percentage}%`)
  }
  if (data.account?.seven_day) {
    limits.push(`7d ${data.account.seven_day.used_percentage}%`)
  }
  if (limits.length) {
    rows.push({ key: 'limits', value: limits.join(' · ') })
  }
  return rows
}

/** Full diagnostic groups shown inside the collapsible Technical details panel. */
export function buildTechnicalGroups(
  data: Detail,
  labels: {
    yes: string
    no: string
    steer: string
    queue: string
  },
): Array<MetaGroup> {
  const loaded: MetaRow = {
    key: 'loaded',
    value: `${data.messages?.length ?? 0} / ${data.total ?? data.messages?.length ?? 0}`,
  }
  const groups: Array<MetaGroup> = (data.meta ?? []).map((group) =>
    group.name === 'transcript'
      ? { ...group, rows: [...group.rows, loaded] }
      : group,
  )
  const r = data.token_rate
  if (r && r.tok_per_s > 0) {
    const parts = [
      r.decode_tok_per_s ? `decode ${formatTokenRate(r.decode_tok_per_s)}` : '',
      r.ttft_ms ? `TTFT ${formatTtft(r.ttft_ms)}` : '',
      r.source,
    ].filter(Boolean)
    if (parts.length) {
      groups.push({
        name: 'usage',
        rows: [
          {
            key: 'output_rate',
            value: `${formatTokenRate(r.tok_per_s)} (${parts.join(' · ')})`,
          },
        ],
      })
    }
  }
  const c = data.capabilities
  if (c) {
    groups.push({
      name: 'capabilities',
      rows: [
        { key: 'ask_options', value: c.ask_options ? labels.yes : labels.no },
        { key: 'plan_review', value: c.plan_review ? labels.yes : labels.no },
        { key: 'usage_source', value: c.usage },
        {
          key: 'account_limits',
          value: c.account_limits ? labels.yes : labels.no,
        },
        {
          key: 'mid_turn_input',
          value: c.mid_turn_input === 'steer' ? labels.steer : labels.queue,
        },
        { key: 'names_sessions', value: c.title ? labels.yes : labels.no },
      ],
    })
  }
  return groups
}
