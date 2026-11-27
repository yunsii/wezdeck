// Background pre-sync for sessions that need attention (waiting / done):
// the shell already polls the session list every 5 s, so when a session enters
// waiting or finishes (or advances its timestamp while there), we incrementally
// pull its latest messages into the persisted TanStack Query cache before the
// user taps in. Deduplicated by (status, waiting_kind, ts), concurrency-capped,
// paused while hidden / offline, and traced as `session-autosync`.
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

import { trace } from '#/lib/client-trace'
import type { Detail } from './console-sessions'
import { isDoneUnread, needsAttention, needsYou } from './console-sessions'
import type { SessionCard } from './session-card'
import { detailKey, readDetail } from './session-detail-read'

export const AUTO_SYNC_LIMIT = 10
export const AUTO_SYNC_CONCURRENCY = 2
export const AUTO_SYNC_RETRY_MS = 30_000

export type AutoSyncTarget = {
  id: string
  sig: string
  status: string
  reason: 'cold' | 'stale'
}

export function syncSignature(
  row: Pick<SessionCard, 'status' | 'waiting_kind' | 'ts'>,
): string {
  return `${row.status}|${row.waiting_kind ?? ''}|${row.ts}`
}

/** Whether the persisted / in-memory detail cache already covers this card. */
export function isCacheCurrent(
  cached:
    Pick<Detail, 'status' | 'waiting_kind' | 'ts' | 'messages'> | undefined,
  row: Pick<SessionCard, 'status' | 'waiting_kind' | 'ts' | 'transcript'>,
): boolean {
  if (!cached) return false
  if (cached.status !== row.status) return false
  if ((cached.waiting_kind ?? '') !== (row.waiting_kind ?? '')) return false
  if (row.ts > 0 && (cached.ts ?? 0) < row.ts) return false
  if (row.transcript && !(cached.messages?.length ?? 0)) return false
  return true
}

/**
 * Pick attention sessions (`waiting` / `done`) whose detail cache is missing
 * or behind the latest list snapshot. Pure and unit-tested.
 */
export function pickAutoSyncTargets({
  sessions,
  activeId,
  synced,
  inFlight,
  failedAt,
  getCached,
  now = Date.now(),
  limit = AUTO_SYNC_LIMIT,
}: {
  sessions: Array<SessionCard>
  activeId?: string
  synced: ReadonlyMap<string, string>
  inFlight: ReadonlySet<string>
  failedAt: ReadonlyMap<string, number>
  getCached: (
    id: string,
  ) => Pick<Detail, 'status' | 'waiting_kind' | 'ts' | 'messages'> | undefined
  now?: number
  limit?: number
}): {
  targets: Array<AutoSyncTarget>
  alreadyCurrent: Array<{ id: string; sig: string }>
} {
  const candidates = sessions
    .filter(
      (row) =>
        !row.restart_pending &&
        row.id !== activeId &&
        needsAttention(row) &&
        (needsYou(row) || isDoneUnread(row)),
    )
    .sort((a, b) => {
      const aw = needsYou(a) ? 1 : 0
      const bw = needsYou(b) ? 1 : 0
      if (aw !== bw) return bw - aw
      return b.ts - a.ts || a.id.localeCompare(b.id)
    })

  const targets: Array<AutoSyncTarget> = []
  const alreadyCurrent: Array<{ id: string; sig: string }> = []

  for (const row of candidates) {
    if (targets.length >= limit) break
    const sig = syncSignature(row)
    if (synced.get(row.id) === sig || inFlight.has(row.id)) continue
    const lastFail = failedAt.get(`${row.id}|${sig}`)
    if (lastFail !== undefined && now - lastFail < AUTO_SYNC_RETRY_MS) continue
    const cached = getCached(row.id)
    if (isCacheCurrent(cached, row)) {
      alreadyCurrent.push({ id: row.id, sig })
      continue
    }
    targets.push({
      id: row.id,
      sig,
      status: row.status,
      reason: cached ? 'stale' : 'cold',
    })
  }

  return { targets, alreadyCurrent }
}

/**
 * Shell-level background sync for waiting and done sessions so tapping into
 * them renders the newest messages immediately from cache.
 */
export function useAutoSyncAttentionSessions(
  sessions: Array<SessionCard> | undefined,
  activeId?: string,
) {
  const client = useQueryClient()
  const syncedRef = useRef(new Map<string, string>())
  const inFlightRef = useRef(new Set<string>())
  const failedAtRef = useRef(new Map<string, number>())
  const latestRef = useRef({ sessions, activeId })
  const mountedRef = useRef(true)
  latestRef.current = { sessions, activeId }

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

      const list = latestRef.current.sessions
      if (!list?.length) return

      // Drop watermarks for sessions that left attention so a later return
      // to waiting/done always re-checks the cache.
      const attentionIds = new Set(
        list
          .filter((row) => !row.restart_pending && needsAttention(row))
          .map((row) => row.id),
      )
      for (const id of syncedRef.current.keys()) {
        if (!attentionIds.has(id)) syncedRef.current.delete(id)
      }

      const { targets, alreadyCurrent } = pickAutoSyncTargets({
        sessions: list,
        activeId: latestRef.current.activeId,
        synced: syncedRef.current,
        inFlight: inFlightRef.current,
        failedAt: failedAtRef.current,
        getCached: (id) => client.getQueryData<Detail>(detailKey(id)),
      })

      for (const item of alreadyCurrent) {
        syncedRef.current.set(item.id, item.sig)
      }

      const slots = Math.max(
        0,
        AUTO_SYNC_CONCURRENCY - inFlightRef.current.size,
      )
      for (const target of targets.slice(0, slots)) {
        inFlightRef.current.add(target.id)
        const started = performance.now()
        void client
          .fetchQuery({
            queryKey: detailKey(target.id),
            queryFn: () => readDetail(client, target.id),
            staleTime: 0,
          })
          .then(() => {
            syncedRef.current.set(target.id, target.sig)
            failedAtRef.current.delete(`${target.id}|${target.sig}`)
            trace('session-autosync', {
              id: target.id,
              status: target.status,
              reason: target.reason,
              outcome: 'ok',
              ms: Math.round(performance.now() - started),
            })
          })
          .catch(() => {
            failedAtRef.current.set(`${target.id}|${target.sig}`, Date.now())
            trace('session-autosync', {
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
  }, [client, sessions, activeId])
}
