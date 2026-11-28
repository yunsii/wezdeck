// Background pre-sync for active sessions (waiting / done / running):
// the shell already polls the session list every 5 s, so when a session enters
// waiting or finishes (or advances its timestamp while there), we incrementally
// pull its latest messages into the persisted TanStack Query cache before the
// user taps in. Running sessions (up to RUNNING_SYNC_LIMIT newest) also warm
// immediately when cold/stale and refresh incrementally every 15 s while the
// tab is visible, capped behind waiting/done in the shared concurrency pool,
// paused while hidden / offline, and traced as `session-autosync`.
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

import { trace } from '#/lib/client-trace'
import { reconcileSessionDetail } from '#/lib/optimistic-state'
import type { Detail } from './console-sessions'
import { isDoneUnread, needsAttention, needsYou } from './console-sessions'
import type { SessionCard } from './session-card'
import { detailKey, readDetail } from './session-detail-read'

export const AUTO_SYNC_LIMIT = 10
export const RUNNING_SYNC_LIMIT = 4
export const RUNNING_SYNC_INTERVAL_MS = 15_000
export const AUTO_SYNC_CONCURRENCY = 2
export const AUTO_SYNC_RETRY_MS = 30_000

export type AutoSyncTarget = {
  id: string
  sig: string
  status: string
  reason: 'cold' | 'stale' | 'running-refresh'
}

export const isRunningCard = (row: Pick<SessionCard, 'status'>) =>
  row.status === 'running'

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
 * Pick attention (`waiting` / `done`) and top `running` sessions whose detail
 * cache is missing, behind the latest list snapshot, or due for a throttled
 * background refresh. Priority: waiting > done > running (newest first).
 * Pure and unit-tested.
 */
export function pickAutoSyncTargets({
  sessions,
  activeId,
  synced,
  syncedAt = new Map<string, number>(),
  inFlight,
  failedAt,
  getCached,
  now = Date.now(),
  limit = AUTO_SYNC_LIMIT,
  runningLimit = RUNNING_SYNC_LIMIT,
  runningIntervalMs = RUNNING_SYNC_INTERVAL_MS,
}: {
  sessions: Array<SessionCard>
  activeId?: string
  synced: ReadonlyMap<string, string>
  syncedAt?: ReadonlyMap<string, number>
  inFlight: ReadonlySet<string>
  failedAt: ReadonlyMap<string, number>
  getCached: (
    id: string,
  ) => Pick<Detail, 'status' | 'waiting_kind' | 'ts' | 'messages'> | undefined
  now?: number
  limit?: number
  runningLimit?: number
  runningIntervalMs?: number
}): {
  targets: Array<AutoSyncTarget>
  alreadyCurrent: Array<{ id: string; sig: string }>
} {
  const rank = (row: SessionCard) =>
    needsYou(row) ? 3 : isDoneUnread(row) ? 2 : isRunningCard(row) ? 1 : 0

  const attention = sessions
    .filter(
      (row) =>
        !row.restart_pending &&
        row.id !== activeId &&
        needsAttention(row) &&
        (needsYou(row) || isDoneUnread(row)),
    )
    .sort((a, b) => {
      const dr = rank(b) - rank(a)
      if (dr !== 0) return dr
      return b.ts - a.ts || a.id.localeCompare(b.id)
    })

  const running = sessions
    .filter(
      (row) =>
        !row.restart_pending &&
        row.id !== activeId &&
        !needsAttention(row) &&
        isRunningCard(row),
    )
    .sort((a, b) => b.ts - a.ts || a.id.localeCompare(b.id))
    .slice(0, runningLimit)

  const candidates = [...attention, ...running]

  const targets: Array<AutoSyncTarget> = []
  const alreadyCurrent: Array<{ id: string; sig: string }> = []

  for (const row of candidates) {
    if (targets.length >= limit) break
    const sig = syncSignature(row)
    if (inFlight.has(row.id)) continue
    const lastFail = failedAt.get(`${row.id}|${sig}`)
    if (lastFail !== undefined && now - lastFail < AUTO_SYNC_RETRY_MS) continue
    const cached = getCached(row.id)
    const isRun = isRunningCard(row) && !needsAttention(row)

    if (isRun) {
      const lastAt = syncedAt.get(row.id)
      const warmRunning =
        Boolean(cached) &&
        cached?.status === 'running' &&
        (!row.transcript || (cached.messages?.length ?? 0) > 0)
      if (
        (warmRunning || synced.get(row.id) === sig) &&
        lastAt !== undefined &&
        now - lastAt < runningIntervalMs
      ) {
        continue
      }
      const current = isCacheCurrent(cached, row)
      targets.push({
        id: row.id,
        sig,
        status: row.status,
        reason: !cached
          ? 'cold'
          : warmRunning || current
            ? 'running-refresh'
            : 'stale',
      })
      continue
    }

    if (synced.get(row.id) === sig) continue
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
 * Shell-level background sync for waiting, done, and top running sessions so
 * tapping into them renders recent messages immediately from cache.
 */
export function useAutoSyncAttentionSessions(
  sessions: Array<SessionCard> | undefined,
  activeId?: string,
) {
  const client = useQueryClient()
  const syncedRef = useRef(new Map<string, string>())
  const syncedAtRef = useRef(new Map<string, number>())
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

  const hasRunning = Boolean(
    sessions?.some(
      (row) =>
        !row.restart_pending && row.id !== activeId && isRunningCard(row),
    ),
  )

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

      // Drop watermarks for sessions that left waiting/done/running so a later
      // return always re-checks the cache.
      const trackedIds = new Set(
        list
          .filter(
            (row) =>
              !row.restart_pending &&
              (needsAttention(row) || isRunningCard(row)),
          )
          .map((row) => row.id),
      )
      for (const id of syncedRef.current.keys()) {
        if (!trackedIds.has(id)) syncedRef.current.delete(id)
      }
      for (const id of syncedAtRef.current.keys()) {
        if (!trackedIds.has(id)) syncedAtRef.current.delete(id)
      }

      const { targets, alreadyCurrent } = pickAutoSyncTargets({
        sessions: list,
        activeId: latestRef.current.activeId,
        synced: syncedRef.current,
        syncedAt: syncedAtRef.current,
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
          .then((merged) => {
            const listRow = latestRef.current.sessions?.find(
              (row) => row.id === target.id,
            )
            reconcileSessionDetail(target.id, merged, Date.now(), { listRow })
            syncedRef.current.set(target.id, target.sig)
            syncedAtRef.current.set(target.id, Date.now())
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

    const timer = hasRunning
      ? window.setInterval(runSweep, RUNNING_SYNC_INTERVAL_MS)
      : undefined
    const onWake = () => {
      if (document.visibilityState === 'visible') runSweep()
    }
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('online', runSweep)
    return () => {
      if (timer !== undefined) window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('online', runSweep)
    }
  }, [client, sessions, activeId, hasRunning])
}
