// Pure ticket list grouping, 4-tab filtering (open / research / ended / all),
// 3-tier priority bucketing inside `open`, and 14-day stale folding:
// - Folds `child` tickets under their `parent` row (with aggregated progress
//   and waiting/running/failed rollup) so parent work never floods the flat list.
// - Defaults to `open` ("待处理"): surfaces waiting_initiator, failed, running,
//   and queued tickets together, prioritized by urgency instead of splitting
//   active vs waiting across separate tabs.
// - Separates standalone `research` tickets into `research` while hiding
//   internal `fanout draft` research children from the top level.
import type { CollabTicket } from '#/lib/runtime-contract'

/** Segments on the tickets page; `inbox` is the old 待处理 route's fixed filter. */
export type TicketFilter = 'open' | 'research' | 'ended' | 'all' | 'inbox'

export const TICKET_FILTERS: ReadonlySet<TicketFilter> = new Set([
  'open',
  'research',
  'ended',
  'all',
  'inbox',
])

/** Map legacy stored filter values (`active` / `mine`) smoothly onto `open`. */
export function normalizeTicketFilter(value: string): TicketFilter | null {
  if (value === 'active' || value === 'mine') return 'open'
  if (TICKET_FILTERS.has(value as TicketFilter) && value !== 'inbox') {
    return value as TicketFilter
  }
  return null
}

/** True terminal states (`failed` stays actionable under `open`). */
export const TERMINAL_TICKET_STATUSES: ReadonlySet<string> = new Set([
  'shipped',
  'closed',
  'rejected',
])
const HARD_CLOSED = new Set(['closed', 'rejected'])
const STALE_DAYS = 14

export type TicketGroupSummary = {
  total: number
  done: number
  running: number
  waiting: number
  failed: number
}

export type TicketGroup = {
  root: CollabTicket
  children: Array<CollabTicket>
  /** latest activity timestamp (ms) across root and children */
  activityAt: number
  summary: TicketGroupSummary
  /** true when search matched inside a child (auto-expand group in UI) */
  matchInChild: boolean
}

export type TicketBucketKey = 'attention' | 'running' | 'queued'

export type TicketBucket = {
  key: TicketBucketKey
  groups: Array<TicketGroup>
}

export function isResearchTicket(ticket: CollabTicket): boolean {
  return ticket.kind === 'research'
}

/** Internal fanout-draft planning research tickets belong under their parent's Plan step. */
export function isInternalDraftResearch(
  ticket: CollabTicket,
  byId: ReadonlyMap<string, CollabTicket>,
): boolean {
  return (
    ticket.kind === 'research' &&
    Boolean(ticket.parent && byId.has(ticket.parent))
  )
}

function ticketTime(iso?: string | null): number {
  const ms = Date.parse(iso ?? '')
  return Number.isFinite(ms) ? ms : 0
}

function summarizeChildren(children: Array<CollabTicket>): TicketGroupSummary {
  let done = 0
  let running = 0
  let waiting = 0
  let failed = 0
  for (const child of children) {
    const hardClosed = HARD_CLOSED.has(child.status ?? '')
    if (!hardClosed && child.running.length > 0) running += 1
    if (child.status === 'waiting_initiator') waiting += 1
    if (child.status === 'failed') failed += 1
    if (TERMINAL_TICKET_STATUSES.has(child.status ?? '')) done += 1
  }
  return { total: children.length, done, running, waiting, failed }
}

function groupSignals(group: TicketGroup) {
  const { root, summary } = group
  const status = root.status ?? ''
  const hardClosed = HARD_CLOSED.has(status)
  const rootTerminal = TERMINAL_TICKET_STATUSES.has(status)
  const anyRunning =
    !hardClosed && (root.running.length > 0 || summary.running > 0)
  const anyWaiting =
    !hardClosed && (status === 'waiting_initiator' || summary.waiting > 0)
  const anyFailed = !hardClosed && (status === 'failed' || summary.failed > 0)
  const managerLive = !hardClosed && root.manager_session?.state === 'live'
  return {
    hardClosed,
    rootTerminal,
    anyRunning,
    anyWaiting,
    anyFailed,
    managerLive,
    research: isResearchTicket(root),
  }
}

/** Group flat `collab.list` rows into top-level rows with nested `children`. */
export function buildTicketGroups(
  allTickets: Array<CollabTicket>,
): Array<TicketGroup> {
  const byId = new Map(allTickets.map((ticket) => [ticket.id, ticket]))
  const childrenByParent = new Map<string, Array<CollabTicket>>()

  for (const ticket of allTickets) {
    if (!ticket.parent || !byId.has(ticket.parent)) continue
    if (isInternalDraftResearch(ticket, byId)) continue
    const list = childrenByParent.get(ticket.parent)
    if (list) list.push(ticket)
    else childrenByParent.set(ticket.parent, [ticket])
  }

  const groups: Array<TicketGroup> = []
  for (const ticket of allTickets) {
    if (ticket.parent && byId.has(ticket.parent)) continue
    const children = (childrenByParent.get(ticket.id) ?? []).sort(
      (a, b) => ticketTime(a.created_at) - ticketTime(b.created_at),
    )
    let activityAt = ticketTime(ticket.updated_at)
    for (const child of children) {
      const ts = ticketTime(child.updated_at)
      if (ts > activityAt) activityAt = ts
    }
    groups.push({
      root: ticket,
      children,
      activityAt,
      summary: summarizeChildren(children),
      matchInChild: false,
    })
  }

  groups.sort((a, b) => b.activityAt - a.activityAt)
  return groups
}

export function groupMatchesFilter(
  group: TicketGroup,
  filter: TicketFilter,
): boolean {
  const s = groupSignals(group)
  switch (filter) {
    case 'all':
      return true
    case 'research':
      return s.research
    case 'inbox':
      return s.anyWaiting || s.anyFailed
    case 'ended':
      return (
        !s.research &&
        s.rootTerminal &&
        !s.anyRunning &&
        !s.anyWaiting &&
        !s.anyFailed
      )
    case 'open':
      if (s.research) return false
      return !s.rootTerminal || s.anyRunning || s.anyWaiting || s.anyFailed
  }
}

export function countTicketFilters(
  groups: Array<TicketGroup>,
): Record<TicketFilter, number> {
  const counts: Record<TicketFilter, number> = {
    open: 0,
    research: 0,
    ended: 0,
    all: 0,
    inbox: 0,
  }
  for (const group of groups) {
    counts.all += 1
    if (groupMatchesFilter(group, 'open')) counts.open += 1
    if (groupMatchesFilter(group, 'research')) counts.research += 1
    if (groupMatchesFilter(group, 'ended')) counts.ended += 1
    if (groupMatchesFilter(group, 'inbox')) counts.inbox += 1
  }
  return counts
}

function ticketMatchesNeedle(ticket: CollabTicket, needle: string): boolean {
  return [
    ticket.id,
    ticket.title,
    ticket.from,
    ticket.to,
    ...ticket.repos,
    ticket.handler?.repo,
  ]
    .filter(Boolean)
    .some((field) => String(field).toLowerCase().includes(needle))
}

export function filterTicketGroups(
  groups: Array<TicketGroup>,
  filter: TicketFilter,
  query: string,
): Array<TicketGroup> {
  const needle = query.trim().toLowerCase()
  const out: Array<TicketGroup> = []
  for (const group of groups) {
    if (!groupMatchesFilter(group, filter)) continue
    if (!needle) {
      out.push(group)
      continue
    }
    const rootHit = ticketMatchesNeedle(group.root, needle)
    const childHit = group.children.some((c) => ticketMatchesNeedle(c, needle))
    if (rootHit || childHit) {
      out.push({ ...group, matchInChild: !rootHit && childHit })
    }
  }
  return out
}

/**
 * Partition `open` ("待处理") tickets into 3 urgency-ordered buckets
 * (`attention` → `running` → `queued`) plus a collapsed `older` tail for
 * inactive tickets untouched for > 14 days.
 */
export function bucketOpenGroups(
  groups: Array<TicketGroup>,
  now = Date.now(),
): { buckets: Array<TicketBucket>; older: Array<TicketGroup> } {
  const cutoff = now - STALE_DAYS * 86_400_000
  const attention: Array<TicketGroup> = []
  const running: Array<TicketGroup> = []
  const queued: Array<TicketGroup> = []
  const older: Array<TicketGroup> = []

  for (const group of groups) {
    const s = groupSignals(group)
    const isLive = s.anyRunning || s.managerLive
    if (!isLive && group.activityAt > 0 && group.activityAt < cutoff) {
      older.push(group)
      continue
    }
    if (s.anyWaiting || s.anyFailed) {
      attention.push(group)
    } else if (isLive || group.root.status === 'in_progress') {
      running.push(group)
    } else {
      queued.push(group)
    }
  }

  const buckets: Array<TicketBucket> = []
  if (attention.length > 0)
    buckets.push({ key: 'attention', groups: attention })
  if (running.length > 0) buckets.push({ key: 'running', groups: running })
  if (queued.length > 0) buckets.push({ key: 'queued', groups: queued })
  return { buckets, older }
}

export function groupIsExpanded(
  group: TicketGroup,
  expandedMap: Readonly<Record<string, boolean>>,
  selectedId?: string,
): boolean {
  if (group.children.length === 0) return false
  if (group.matchInChild) return true
  if (selectedId && group.children.some((c) => c.id === selectedId)) return true
  if (Object.prototype.hasOwnProperty.call(expandedMap, group.root.id)) {
    return expandedMap[group.root.id]
  }
  return group.summary.running > 0 || group.summary.waiting > 0
}

export function flattenVisibleGroupIds(
  groups: Array<TicketGroup>,
  expandedMap: Readonly<Record<string, boolean>>,
  selectedId?: string,
): Array<string> {
  const ids: Array<string> = []
  for (const group of groups) {
    ids.push(group.root.id)
    if (groupIsExpanded(group, expandedMap, selectedId)) {
      for (const child of group.children) ids.push(child.id)
    }
  }
  return ids
}
