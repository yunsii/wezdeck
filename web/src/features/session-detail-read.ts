import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  applySessionDetailOverlay,
  reconcileSessionDetail,
  useSessionOptimistic,
} from '#/lib/optimistic-state'
import { hostRead } from '#/lib/runtime-client'
import { mergeReply, pollArgs } from '#/lib/session-cache'
import { traceSessionSync } from '#/lib/session-sync-trace'
import type { Detail } from './console-sessions'
import type { SessionsReply } from './session-delete-state'

export const detailKey = (id: string) => ['remote', 'session', id] as const

/** One incremental read, merged with the latest cache after the request. */
export async function readDetail(client: QueryClient, id: string) {
  const key = detailKey(id)
  const reply = (await hostRead(
    'session',
    pollArgs(id, client.getQueryData<Detail>(key)),
  )) as Detail
  const have = client.getQueryData<Detail>(key)
  traceSessionSync(have, reply, id)
  return mergeReply(have, reply)
}

export function useSessionDetail(
  id: string,
  busyOf: (data: Detail) => boolean,
) {
  const client = useQueryClient()
  const key = detailKey(id)
  const overlay = useSessionOptimistic(id)
  const overlayRef = useRef(overlay)
  overlayRef.current = overlay
  const detail = useQuery({
    queryKey: key,
    enabled: typeof window !== 'undefined',
    refetchInterval: (query) => {
      const activeOverlay = overlayRef.current
      if (activeOverlay && !activeOverlay.settledOn?.detail) return 1_000
      return query.state.data && busyOf(query.state.data) ? 1_000 : 2_500
    },
    queryFn: () => readDetail(client, id),
  })
  useEffect(() => {
    if (!detail.data || !overlay) return
    const listRow = client
      .getQueryData<SessionsReply>(['remote', 'sessions'])
      ?.sessions.find((row) => row.id === id)
    reconcileSessionDetail(id, detail.data, Date.now(), { listRow })
  }, [client, id, detail.data, overlay])
  const data = useMemo(
    () => applySessionDetailOverlay(detail.data, overlay),
    [detail.data, overlay],
  )
  const pagingRef = useRef(false)
  const [pagingIn, setPagingIn] = useState(false)
  const loadEarlier = useCallback(
    async (count: number, onBeforeMerge?: () => void) => {
      const have = client.getQueryData<Detail>(key)
      if (!have || pagingRef.current) return false
      pagingRef.current = true
      setPagingIn(true)
      try {
        const reply = (await hostRead('session', {
          id,
          before: have.start ?? 0,
          messages_rev: have.messages_rev ?? 0,
          limit: count,
        })) as Detail
        onBeforeMerge?.()
        client.setQueryData<Detail>(key, (now) => mergeReply(now, reply))
        return true
      } finally {
        pagingRef.current = false
        setPagingIn(false)
      }
    },
    [client, id, key],
  )
  return { detail, data, rawData: detail.data, pagingIn, loadEarlier }
}
