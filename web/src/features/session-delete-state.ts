import { useMutationState, useQuery } from '@tanstack/react-query'

import { useCallback } from 'react'

import { hostRead } from '#/lib/runtime-client'
import type { SessionCard } from './session-card'

export const sessionDeleteKey = ['session.delete'] as const

export type SessionsReply = {
  sessions: Array<SessionCard>
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
  const pending = usePendingSessionDeletes()
  const select = useCallback(
    (data: SessionsReply) => hideDeletedSessions(data, new Set(pending)),
    [pending],
  )
  return useQuery({
    queryKey: ['remote', 'sessions'],
    enabled: typeof window !== 'undefined',
    refetchInterval: 5_000,
    queryFn: async () => (await hostRead('sessions', {})) as SessionsReply,
    select,
  })
}
