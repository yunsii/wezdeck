import {
  useMutationState,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'

import { useCallback, useEffect, useRef } from 'react'

import {
  applySessionsListOverlay,
  reconcileSessionsList,
  useAllSessionOptimistics,
} from '#/lib/optimistic-state'
import { hostRead } from '#/lib/runtime-client'
import type { SessionCard } from './session-card'
import type { Detail } from './session-detail-types'
import type { NewSessionJob } from './session-new-route'

export const sessionDeleteKey = ['session.delete'] as const
export const LAST_SESSION_KEY = 'wezdeck-last-session'

const MISSING_TTL_MS = 30_000
const missingSessions = new Map<string, number>()

export const isMissingSessionError = (error: unknown) =>
  /session not found|ended or not tracked/i.test(
    error instanceof Error ? error.message : String(error ?? ''),
  )

export function markSessionMissing(id: string) {
  if (id) missingSessions.set(id, Date.now() + MISSING_TTL_MS)
}

export function clearSessionMissing(id: string) {
  missingSessions.delete(id)
}

export function isSessionMissing(id: string, detailError?: unknown) {
  if (detailError && isMissingSessionError(detailError)) return true
  const until = missingSessions.get(id)
  if (until === undefined) return false
  if (Date.now() > until) {
    missingSessions.delete(id)
    return false
  }
  return true
}

export type SessionsReply = {
  sessions: Array<SessionCard>
  creating_jobs?: Array<NewSessionJob>
  redirects?: Array<{ from: string; to: string }>
}

export type SessionDeleteRequest = { id: string; force?: boolean }
export type SessionDeleteReply = { worktree_outcome: string }

export function hideDeletedSessions(data: SessionsReply, ids: Set<string>) {
  if (!data.sessions.some((row) => ids.has(row.id))) return data
  return { ...data, sessions: data.sessions.filter((row) => !ids.has(row.id)) }
}

export function usePendingSessionDeletes() {
  return useMutationState({
    filters: { mutationKey: sessionDeleteKey, status: 'pending' },
    select: (mutation) => (mutation.state.variables as SessionDeleteRequest).id,
  })
}

export function useSessionDeleteReview(id: string) {
  const outcomes = useMutationState({
    filters: {
      mutationKey: sessionDeleteKey,
      status: 'success',
      predicate: (mutation) =>
        (mutation.state.variables as SessionDeleteRequest).id === id,
    },
    select: (mutation) =>
      (mutation.state.data as SessionDeleteReply).worktree_outcome,
  })
  return outcomes.at(-1) === 'review_required'
}

export function useSessions() {
  const client = useQueryClient()
  const pending = usePendingSessionDeletes()
  const overlays = useAllSessionOptimistics()
  const hasActiveListOverlay = [...overlays.values()].some(
    (item) => !item.settledOn?.list,
  )
  const hasOverlaysRef = useRef(hasActiveListOverlay)
  hasOverlaysRef.current = hasActiveListOverlay
  const select = useCallback(
    (data: SessionsReply) =>
      applySessionsListOverlay(
        hideDeletedSessions(data, new Set(pending)),
        overlays,
      ),
    [pending, overlays],
  )
  const query = useQuery({
    queryKey: ['remote', 'sessions'],
    enabled: typeof window !== 'undefined',
    refetchInterval: () => (hasOverlaysRef.current ? 1_500 : 5_000),
    queryFn: () => hostRead('sessions', {}) as Promise<SessionsReply>,
    select,
  })
  useEffect(() => {
    if (overlays.size === 0) return
    const raw = client.getQueryData<SessionsReply>(['remote', 'sessions'])
    if (!raw?.sessions.length) return
    reconcileSessionsList(raw.sessions, Date.now(), {
      getDetail: (sid) =>
        client.getQueryData<Detail>(['remote', 'session', sid]),
    })
  }, [client, query.dataUpdatedAt, overlays])
  return query
}
