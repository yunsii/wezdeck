// Collab ticket optimistic overlay store: projects ticket replies, split
// proposal decisions, manager session wake/park/send, and delivery actions
// across collab show, list, and health badges at 0ms while reconciling cleanly.
import { useSyncExternalStore } from 'react'

import { trace } from './client-trace'
import { notifyOptimisticTimeout } from './optimistic-state'
import type {
  CollabHealth,
  CollabList,
  CollabShow,
  CollabTicket,
} from './runtime-contract'

export const TICKET_OVERLAY_TTL_MS = 15_000

export type TicketOptimisticKind =
  | 'reply'
  | 'proposal-approve'
  | 'proposal-reject'
  | 'manager-send'
  | 'manager-park'
  | 'manager-start'
  | 'deliver'
  | 'fix'

export type TicketOptimistic = {
  id: string
  opId: string
  kind: TicketOptimisticKind
  phase: 'in-flight' | 'settling'
  createdAt: number
  acceptedAt?: number
  ttlMs: number
  continueRun?: boolean
  proposalId?: string
  replyText?: string
  settledOn?: { show?: boolean; list?: boolean }
  baseline: {
    status?: string | null
    updated?: string | null
    proposalsCount?: number
    managerState?: string | null
  }
}

export function ticketUpdatedOf(
  ticket?: CollabTicket | null,
): string | undefined {
  if (!ticket) return undefined
  if (typeof ticket.updated_at === 'string' && ticket.updated_at)
    return ticket.updated_at
  if (typeof ticket.updated === 'string' && ticket.updated)
    return ticket.updated
  return undefined
}

const ticketOverlays = new Map<string, TicketOptimistic>()
const ticketTimers = new Map<string, ReturnType<typeof setTimeout>>()
const listeners = new Set<() => void>()
let ticketSnapshot: ReadonlyMap<string, TicketOptimistic> = new Map()

function emit() {
  ticketSnapshot = new Map(ticketOverlays)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function clearTicketTimer(id: string) {
  const existing = ticketTimers.get(id)
  if (existing !== undefined) {
    clearTimeout(existing)
    ticketTimers.delete(id)
  }
}

function scheduleTicketTimeout(id: string, opId: string, ttlMs: number) {
  clearTicketTimer(id)
  ticketTimers.set(
    id,
    setTimeout(() => {
      const current = ticketOverlays.get(id)
      if (!current || current.opId !== opId) return
      const alreadyConfirmed = Boolean(
        current.settledOn?.show || current.settledOn?.list,
      )
      ticketOverlays.delete(id)
      ticketTimers.delete(id)
      trace('optimistic', {
        scope: 'ticket',
        id,
        op_id: opId,
        action: current.kind,
        event: alreadyConfirmed ? 'settle' : 'timeout',
        latency_ms: Date.now() - current.createdAt,
      })
      emit()
      if (!alreadyConfirmed) {
        notifyOptimisticTimeout({
          scope: 'ticket',
          id,
          opId,
          kind: current.kind,
        })
      }
    }, ttlMs),
  )
}

export function applyTicketOptimistic(
  entry: Omit<TicketOptimistic, 'phase' | 'createdAt' | 'ttlMs'> & {
    createdAt?: number
    ttlMs?: number
  },
) {
  const createdAt = entry.createdAt ?? Date.now()
  clearTicketTimer(entry.id)
  ticketOverlays.set(entry.id, {
    ...entry,
    phase: 'in-flight',
    createdAt,
    ttlMs: entry.ttlMs ?? TICKET_OVERLAY_TTL_MS,
  })
  trace('optimistic', {
    scope: 'ticket',
    id: entry.id,
    op_id: entry.opId,
    action: entry.kind,
    event: 'apply',
  })
  emit()
}

export function acceptTicketOptimistic(
  id: string,
  opId: string,
  now = Date.now(),
) {
  const current = ticketOverlays.get(id)
  if (!current || current.opId !== opId) return
  ticketOverlays.set(id, { ...current, phase: 'settling', acceptedAt: now })
  scheduleTicketTimeout(id, opId, current.ttlMs)
  emit()
}

export function rollbackTicketOptimistic(
  id: string,
  opId: string,
  reason?: string,
) {
  const current = ticketOverlays.get(id)
  if (!current || current.opId !== opId) return
  clearTicketTimer(id)
  ticketOverlays.delete(id)
  trace('optimistic', {
    scope: 'ticket',
    id,
    op_id: opId,
    action: current.kind,
    event: 'rollback',
    reason: reason ?? null,
    latency_ms: Date.now() - current.createdAt,
  })
  emit()
}

export function isTicketShowOverlaySettled(
  overlay: TicketOptimistic,
  server: CollabShow,
  now = Date.now(),
): 'active' | 'settled' | 'timeout' {
  if (
    overlay.phase === 'settling' &&
    overlay.acceptedAt !== undefined &&
    now - overlay.acceptedAt >= overlay.ttlMs
  ) {
    return 'timeout'
  }
  if (overlay.phase === 'in-flight') return 'active'
  if (!server.ok || !server.ticket) return 'active'
  const ticket = server.ticket
  const currentUpdated = ticketUpdatedOf(ticket)
  const updatedChanged =
    Boolean(overlay.baseline.updated) &&
    Boolean(currentUpdated) &&
    currentUpdated !== overlay.baseline.updated

  switch (overlay.kind) {
    case 'reply':
    case 'deliver':
    case 'fix':
      return ticket.status !== overlay.baseline.status || updatedChanged
        ? 'settled'
        : 'active'
    case 'proposal-approve':
    case 'proposal-reject': {
      const stillPresent = overlay.proposalId
        ? server.proposals.some((p) => p.id === overlay.proposalId)
        : server.proposals.length >= (overlay.baseline.proposalsCount ?? 1)
      return !stillPresent || updatedChanged ? 'settled' : 'active'
    }
    case 'manager-start':
    case 'manager-send':
      return ticket.manager_session?.state === 'live' ? 'settled' : 'active'
    case 'manager-park':
      return ticket.manager_session?.state === 'parked' ? 'settled' : 'active'
  }
}

export function isTicketRowOverlaySettled(
  overlay: TicketOptimistic,
  row: CollabTicket,
  now = Date.now(),
): 'active' | 'settled' | 'timeout' {
  if (
    overlay.phase === 'settling' &&
    overlay.acceptedAt !== undefined &&
    now - overlay.acceptedAt >= overlay.ttlMs
  ) {
    return 'timeout'
  }
  if (overlay.phase === 'in-flight') return 'active'
  const currentUpdated = ticketUpdatedOf(row)
  const updatedChanged =
    Boolean(overlay.baseline.updated) &&
    Boolean(currentUpdated) &&
    currentUpdated !== overlay.baseline.updated

  switch (overlay.kind) {
    case 'reply':
    case 'proposal-approve':
    case 'proposal-reject':
    case 'deliver':
    case 'fix':
      return row.status !== overlay.baseline.status || updatedChanged
        ? 'settled'
        : 'active'
    case 'manager-start':
    case 'manager-send':
      return row.manager_session?.state === 'live' ? 'settled' : 'active'
    case 'manager-park':
      return row.manager_session?.state === 'parked' ? 'settled' : 'active'
  }
}

export function reconcileTicketShow(
  id: string,
  server: CollabShow | undefined,
  now = Date.now(),
  other?: { listRow?: CollabTicket },
) {
  if (!server) return
  const overlay = ticketOverlays.get(id)
  if (!overlay) return
  const state = isTicketShowOverlaySettled(overlay, server, now)
  if (state === 'active') return
  if (
    state === 'settled' &&
    other?.listRow &&
    !overlay.settledOn?.list &&
    isTicketRowOverlaySettled(overlay, other.listRow, now) === 'active'
  ) {
    if (!overlay.settledOn?.show) {
      ticketOverlays.set(id, {
        ...overlay,
        settledOn: { ...overlay.settledOn, show: true },
      })
      emit()
    }
    return
  }
  const alreadyConfirmed = Boolean(
    overlay.settledOn?.show || overlay.settledOn?.list,
  )
  const isTimeout = state === 'timeout' && !alreadyConfirmed
  clearTicketTimer(id)
  ticketOverlays.delete(id)
  trace('optimistic', {
    scope: 'ticket',
    id,
    op_id: overlay.opId,
    action: overlay.kind,
    event: isTimeout ? 'timeout' : 'settle',
    latency_ms: now - overlay.createdAt,
  })
  emit()
  if (isTimeout) {
    notifyOptimisticTimeout({
      scope: 'ticket',
      id,
      opId: overlay.opId,
      kind: overlay.kind,
    })
  }
}

export function reconcileTicketList(
  list: CollabList | undefined,
  now = Date.now(),
  other?: { getShow?: (id: string) => CollabShow | undefined },
) {
  if (!list?.ok || ticketOverlays.size === 0) return
  let changed = false
  for (const row of list.tickets) {
    const overlay = ticketOverlays.get(row.id)
    if (!overlay) continue
    const state = isTicketRowOverlaySettled(overlay, row, now)
    if (state === 'active') continue
    const cachedShow = other?.getShow?.(row.id)
    if (
      state === 'settled' &&
      cachedShow &&
      !overlay.settledOn?.show &&
      isTicketShowOverlaySettled(overlay, cachedShow, now) === 'active'
    ) {
      if (!overlay.settledOn?.list) {
        ticketOverlays.set(row.id, {
          ...overlay,
          settledOn: { ...overlay.settledOn, list: true },
        })
        changed = true
      }
      continue
    }
    const alreadyConfirmed = Boolean(
      overlay.settledOn?.show || overlay.settledOn?.list,
    )
    const isTimeout = state === 'timeout' && !alreadyConfirmed
    clearTicketTimer(row.id)
    ticketOverlays.delete(row.id)
    changed = true
    trace('optimistic', {
      scope: 'ticket',
      id: row.id,
      op_id: overlay.opId,
      action: overlay.kind,
      event: isTimeout ? 'timeout' : 'settle',
      via: 'list',
      latency_ms: now - overlay.createdAt,
    })
  }
  if (changed) emit()
}

function projectTicketStatus(
  ticket: CollabTicket,
  overlay: TicketOptimistic,
): CollabTicket {
  switch (overlay.kind) {
    case 'reply':
      return {
        ...ticket,
        status: overlay.continueRun ? 'in_progress' : 'waiting_target',
      }
    case 'proposal-approve':
    case 'deliver':
    case 'fix':
      return { ...ticket, status: 'in_progress' }
    case 'proposal-reject':
      return {
        ...ticket,
        status:
          ticket.status === 'waiting_initiator'
            ? 'waiting_target'
            : ticket.status,
      }
    case 'manager-start':
    case 'manager-send':
      return ticket.manager_session
        ? {
            ...ticket,
            manager_session: { ...ticket.manager_session, state: 'live' },
          }
        : ticket
    case 'manager-park':
      return ticket.manager_session
        ? {
            ...ticket,
            manager_session: { ...ticket.manager_session, state: 'parked' },
          }
        : ticket
  }
}

export function applyCollabShowOverlay(
  show: CollabShow | undefined,
  overlay: TicketOptimistic | undefined,
  now = Date.now(),
): CollabShow | undefined {
  if (!show || !show.ok || !show.ticket || !overlay || overlay.settledOn?.show)
    return show
  if (isTicketShowOverlaySettled(overlay, show, now) !== 'active') return show
  const nextTicket = projectTicketStatus(show.ticket, overlay)
  const nextProposals =
    (overlay.kind === 'proposal-approve' ||
      overlay.kind === 'proposal-reject') &&
    overlay.proposalId
      ? show.proposals.filter((p) => p.id !== overlay.proposalId)
      : show.proposals
  const nextQuestions = overlay.kind === 'reply' ? null : show.questions
  return {
    ...show,
    ticket: nextTicket,
    proposals: nextProposals,
    questions: nextQuestions,
  }
}

export function applyCollabListOverlay(
  list: CollabList | undefined,
  overlays: ReadonlyMap<string, TicketOptimistic>,
  now = Date.now(),
): CollabList | undefined {
  if (!list || !list.ok || overlays.size === 0) return list
  let changed = false
  const tickets: Array<CollabTicket> = []
  for (const row of list.tickets) {
    const overlay = overlays.get(row.id)
    if (
      !overlay ||
      overlay.settledOn?.list ||
      isTicketRowOverlaySettled(overlay, row, now) !== 'active'
    ) {
      tickets.push(row)
      continue
    }
    changed = true
    tickets.push(projectTicketStatus(row, overlay))
  }
  return changed ? { ...list, tickets } : list
}

export function applyCollabHealthOverlay(
  health: CollabHealth | undefined,
  overlays: ReadonlyMap<string, TicketOptimistic>,
  now = Date.now(),
): CollabHealth | undefined {
  if (!health || !health.ok || overlays.size === 0) return health
  let waitingDelta = 0
  for (const overlay of overlays.values()) {
    if (overlay.settledOn?.list) continue
    if (
      overlay.phase === 'settling' &&
      overlay.acceptedAt !== undefined &&
      now - overlay.acceptedAt >= overlay.ttlMs
    ) {
      continue
    }
    if (
      overlay.baseline.status === 'waiting_initiator' &&
      (overlay.kind === 'reply' ||
        overlay.kind === 'proposal-approve' ||
        overlay.kind === 'proposal-reject')
    ) {
      waitingDelta -= 1
    }
  }
  if (waitingDelta === 0) return health
  return {
    ...health,
    waiting_human: Math.max(0, health.waiting_human + waitingDelta),
  }
}

export function useAllTicketOptimistics() {
  return useSyncExternalStore(
    subscribe,
    () => ticketSnapshot,
    () => ticketSnapshot,
  )
}

export function useTicketOptimistic(id: string) {
  return useAllTicketOptimistics().get(id)
}

export function resetTicketOptimisticForTest() {
  for (const timer of ticketTimers.values()) clearTimeout(timer)
  ticketTimers.clear()
  ticketOverlays.clear()
  emit()
}
