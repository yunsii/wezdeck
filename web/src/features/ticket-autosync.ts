// Background pre-sync for tickets that need attention (waiting_initiator /
// running): the shell already keeps the ticket list warm via useTicketSync, so
// when a ticket enters waiting_initiator or has a running worker (or advances
// updated_at while there), we incrementally pull `collab show` into the
// persisted TanStack Query cache before the user taps in. Deduplicated by
// (status, updated_at, running.length), concurrency-capped, paused while
// hidden / offline, and traced as `ticket-autosync`.
import type { QueryClient } from '@tanstack/react-query'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

import { trace } from '#/lib/client-trace'
import { collabKey } from '#/lib/collab-query'
import { getCollab } from '#/lib/runtime-client'
import type { CollabShow, CollabTicket } from '#/lib/runtime-contract'

export const TICKET_AUTO_SYNC_LIMIT = 8
export const TICKET_AUTO_SYNC_CONCURRENCY = 2
export const TICKET_AUTO_SYNC_RETRY_MS = 30_000

export type TicketAutoSyncTarget = {
  id: string
  sig: string
  status: string
  reason: 'cold' | 'stale'
}

export function needsTicketAutoSync(
  row: Pick<CollabTicket, 'status' | 'running'>,
): boolean {
  return row.status === 'waiting_initiator' || row.running.length > 0
}

export function ticketSyncSignature(
  row: Pick<CollabTicket, 'status' | 'updated_at' | 'running'>,
): string {
  return `${row.status ?? ''}|${row.updated_at ?? ''}|${row.running.length}`
}

/** Whether the persisted / in-memory `collab show` cache already covers this row. */
export function isTicketCacheCurrent(
  cached: Pick<CollabShow, 'ok' | 'ticket'> | undefined,
  row: Pick<CollabTicket, 'status' | 'updated_at' | 'running'>,
): boolean {
  if (!cached?.ok || !cached.ticket) return false
  if ((cached.ticket.status ?? '') !== (row.status ?? '')) return false
  if (cached.ticket.running.length !== row.running.length) return false
  const rowMs = Date.parse(row.updated_at ?? '')
  const cachedMs = Date.parse(cached.ticket.updated_at ?? '')
  if (Number.isFinite(rowMs) && rowMs > 0) {
    if (!Number.isFinite(cachedMs) || cachedMs < rowMs) return false
  }
  return true
}

/**
 * Pick waiting / running tickets whose `collab show` cache is missing or
 * behind the latest list snapshot. Pure and unit-tested.
 */
export function pickTicketAutoSyncTargets({
  tickets,
  activeId,
  synced,
  inFlight,
  failedAt,
  getCached,
  now = Date.now(),
  limit = TICKET_AUTO_SYNC_LIMIT,
}: {
  tickets: Array<CollabTicket>
  activeId?: string
  synced: ReadonlyMap<string, string>
  inFlight: ReadonlySet<string>
  failedAt: ReadonlyMap<string, number>
  getCached: (id: string) => Pick<CollabShow, 'ok' | 'ticket'> | undefined
  now?: number
  limit?: number
}): {
  targets: Array<TicketAutoSyncTarget>
  alreadyCurrent: Array<{ id: string; sig: string }>
} {
  const candidates = tickets
    .filter((row) => row.id !== activeId && needsTicketAutoSync(row))
    .sort((a, b) => {
      const aw = a.status === 'waiting_initiator' ? 1 : 0
      const bw = b.status === 'waiting_initiator' ? 1 : 0
      if (aw !== bw) return bw - aw
      const at = Date.parse(a.updated_at ?? '') || 0
      const bt = Date.parse(b.updated_at ?? '') || 0
      return bt - at || a.id.localeCompare(b.id)
    })

  const targets: Array<TicketAutoSyncTarget> = []
  const alreadyCurrent: Array<{ id: string; sig: string }> = []

  for (const row of candidates) {
    if (targets.length >= limit) break
    const sig = ticketSyncSignature(row)
    if (synced.get(row.id) === sig || inFlight.has(row.id)) continue
    const lastFail = failedAt.get(`${row.id}|${sig}`)
    if (lastFail !== undefined && now - lastFail < TICKET_AUTO_SYNC_RETRY_MS)
      continue
    const cached = getCached(row.id)
    if (isTicketCacheCurrent(cached, row)) {
      alreadyCurrent.push({ id: row.id, sig })
      continue
    }
    targets.push({
      id: row.id,
      sig,
      status: row.running.length > 0 ? 'running' : (row.status ?? ''),
      reason: cached?.ok ? 'stale' : 'cold',
    })
  }

  return { targets, alreadyCurrent }
}

/** Warm `collab show` on pointer hover / down / focus / keyboard neighbor. */
export function prefetchTicket(client: QueryClient, id: string) {
  if (!id) return
  void client.prefetchQuery({
    queryKey: collabKey('show', { id }),
    queryFn: () => getCollab('show', { id }),
    staleTime: 5_000,
  })
}

/**
 * Shell-level background sync for waiting and running tickets so tapping into
 * them renders immediately from cache.
 */
export function useAutoSyncTickets(
  tickets: Array<CollabTicket> | undefined,
  activeId?: string,
) {
  const client = useQueryClient()
  const syncedRef = useRef(new Map<string, string>())
  const inFlightRef = useRef(new Set<string>())
  const failedAtRef = useRef(new Map<string, number>())
  const latestRef = useRef({ tickets, activeId })
  const mountedRef = useRef(true)
  latestRef.current = { tickets, activeId }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    const runSweep = () => {
      if (!mountedRef.current) return
      if (
        typeof document !== 'undefined' &&
        document.visibilityState !== 'visible'
      )
        return
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return

      const list = latestRef.current.tickets
      if (!list?.length) return

      // Drop watermarks for tickets that left attention so a later return
      // always re-checks the cache.
      const watchIds = new Set(
        list.filter((row) => needsTicketAutoSync(row)).map((row) => row.id),
      )
      for (const id of syncedRef.current.keys()) {
        if (!watchIds.has(id)) syncedRef.current.delete(id)
      }

      const { targets, alreadyCurrent } = pickTicketAutoSyncTargets({
        tickets: list,
        activeId: latestRef.current.activeId,
        synced: syncedRef.current,
        inFlight: inFlightRef.current,
        failedAt: failedAtRef.current,
        getCached: (id) =>
          client.getQueryData<CollabShow>(collabKey('show', { id })),
      })

      for (const item of alreadyCurrent) {
        syncedRef.current.set(item.id, item.sig)
      }

      const slots = Math.max(
        0,
        TICKET_AUTO_SYNC_CONCURRENCY - inFlightRef.current.size,
      )
      for (const target of targets.slice(0, slots)) {
        inFlightRef.current.add(target.id)
        const started = performance.now()
        void client
          .fetchQuery({
            queryKey: collabKey('show', { id: target.id }),
            queryFn: () => getCollab('show', { id: target.id }),
            staleTime: 0,
          })
          .then((res) => {
            if (!res.ok) throw new Error(res.error?.message ?? 'collab error')
            syncedRef.current.set(target.id, target.sig)
            failedAtRef.current.delete(`${target.id}|${target.sig}`)
            trace('ticket-autosync', {
              id: target.id,
              status: target.status,
              reason: target.reason,
              outcome: 'ok',
              ms: Math.round(performance.now() - started),
            })
          })
          .catch(() => {
            failedAtRef.current.set(`${target.id}|${target.sig}`, Date.now())
            trace('ticket-autosync', {
              id: target.id,
              status: target.status,
              reason: target.reason,
              outcome: 'error',
              ms: Math.round(performance.now() - started),
            })
          })
          .finally(() => {
            inFlightRef.current.delete(target.id)
            if (mountedRef.current) runSweep()
          })
      }
    }

    runSweep()

    const onWake = () => {
      if (document.visibilityState === 'visible') runSweep()
    }
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('online', runSweep)
    return () => {
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('online', runSweep)
    }
  }, [client, tickets, activeId])
}
