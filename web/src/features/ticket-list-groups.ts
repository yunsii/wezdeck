// Pure 3+1 ticket list grouping & filtering helpers:
// - Folds `child` tickets under their `parent` row (with aggregated progress
//   and waiting/running/failed rollup) so parent work never floods the flat list.
// - Separates standalone `research` tickets into a dedicated `research` filter
//   while hiding internal `fanout draft` research children from the top level.
import type { CollabTicket } from '#/lib/runtime-contract'

/** Segments on the tickets page; `inbox` is the old 待处理 route's fixed filter. */
export type TicketFilter =
  'all' | 'active' | 'mine' | 'research' | 'ended' | 'inbox'

export const TICKET_FILTERS: ReadonlySet<TicketFilter> = new Set([
  'all',
  'active',
  'mine',
  'research',
  'ended',
  'inbox',
])

const ENDED = new Set(['shipped', 'closed', 'failed', 'rejected'])
const QUIET_DAYS = 7

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
    if (child.running.length > 0) running += 1
    if (child.status === 'waiting_initiator') waiting += 1
    if (child.status === 'failed' || child.status === 'rejected') failed += 1
    if (child.status === 'shipped' || child.status === 'closed') done += 1
  }
  return { total: children.length, done, running, waiting, failed }
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
    // Nested under an existing parent: folded, not duplicated at top level.
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
  const { root, summary } = group
  const rootEnded = ENDED.has(root.status ?? '')
  const rootRunning = root.running.length > 0
  const anyRunning = rootRunning || summary.running > 0
  const anyWaiting = root.status === 'waiting_initiator' || summary.waiting > 0
  const research = isResearchTicket(root)

  switch (filter) {
    case 'all':
      return true
    case 'research':
      return research
    case 'mine':
      return anyWaiting
    case 'inbox':
      return (
        anyWaiting ||
        root.status === 'failed' ||
        root.status === 'rejected' ||
        summary.failed > 0
      )
    case 'ended':
      return !research && rootEnded && !anyRunning && !anyWaiting
    case 'active':
      if (research) return false
      return anyRunning || (!rootEnded && root.status !== 'waiting_initiator')
  }
}

export function countTicketFilters(
  groups: Array<TicketGroup>,
): Record<TicketFilter, number> {
  const counts: Record<TicketFilter, number> = {
    all: 0,
    active: 0,
    mine: 0,
    research: 0,
    ended: 0,
    inbox: 0,
  }
  for (const group of groups) {
    counts.all += 1
    if (groupMatchesFilter(group, 'active')) counts.active += 1
    if (groupMatchesFilter(group, 'mine')) counts.mine += 1
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

export function splitQuietGroups(
  groups: Array<TicketGroup>,
  now = Date.now(),
): { recent: Array<TicketGroup>; older: Array<TicketGroup> } {
  const cutoff = now - QUIET_DAYS * 86_400_000
  const quiet = (g: TicketGroup) =>
    g.root.running.length === 0 &&
    g.summary.running === 0 &&
    g.root.status !== 'waiting_initiator' &&
    g.summary.waiting === 0 &&
    g.activityAt < cutoff
  return {
    recent: groups.filter((g) => !quiet(g)),
    older: groups.filter(quiet),
  }
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
  // Auto-expand parents that currently have running or waiting children; fold quiet/ended parents.
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
