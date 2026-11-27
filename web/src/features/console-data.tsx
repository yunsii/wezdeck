import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import { createContext, useContext, useEffect } from 'react'

import {
  getRuntimeSnapshot,
  getWslBridgeStatus,
  getBrowserSlot,
  getWakatimeStatus,
  probeRuntime,
  runtimeEventsUrl,
} from '#/lib/runtime-client'
import { useRuntimeRestartNotice } from './runtime-restart'

type RuntimeData = ReturnType<typeof useRuntimeDataQuery>

const emptyQuery = {
  data: undefined,
  error: null,
  isPending: false,
  isError: false,
  refetch: () => Promise.resolve({} as never),
} as const

/** Older provider values omit queries added after the page was written. */
export function runtimeQuery<T>(
  query: UseQueryResult<T> | undefined,
): UseQueryResult<T> {
  return (query ?? emptyQuery) as UseQueryResult<T>
}

const RuntimeDataContext = createContext<RuntimeData | null>(null)

function useRuntimeDataQuery() {
  const queryClient = useQueryClient()
  const snapshot = useQuery({
    queryKey: ['runtime', 'snapshot'],
    queryFn: getRuntimeSnapshot,
    enabled: typeof window !== 'undefined',
    refetchInterval: 5_000,
  })
  const probe = useQuery({
    queryKey: ['runtime', 'probe'],
    queryFn: probeRuntime,
    enabled: typeof window !== 'undefined',
    refetchInterval: 5_000,
  })
  const wsl = useQuery({
    queryKey: ['runtime', 'wsl'],
    queryFn: getWslBridgeStatus,
    enabled: typeof window !== 'undefined',
    refetchInterval: 15_000,
    throwOnError: false,
  })

  const browser = useQuery({
    queryKey: ['runtime', 'browser'],
    queryFn: getBrowserSlot,
    enabled: typeof window !== 'undefined',
    refetchInterval: 15_000,
    throwOnError: false,
  })
  const wakatime = useQuery({
    queryKey: ['runtime', 'wakatime'],
    queryFn: getWakatimeStatus,
    enabled: typeof window !== 'undefined',
    refetchInterval: 60_000,
    throwOnError: false,
  })

  useEffect(() => {
    const baseUrl = probe.data?.baseUrl
    if (!baseUrl || typeof window === 'undefined') return
    const socket = new WebSocket(runtimeEventsUrl(baseUrl))
    // a runtime event refreshes the runtime reads, not the ticket ones:
    // those sync on their own change signal (lib/ticket-sync.ts)
    socket.onmessage = () =>
      void queryClient.invalidateQueries({
        queryKey: ['runtime'],
        predicate: (query) => query.queryKey[1] !== 'collab',
      })
    return () => socket.close()
  }, [probe.data?.baseUrl, queryClient])

  const refreshAll = () =>
    Promise.all([
      snapshot.refetch(),
      probe.refetch(),
      wsl.refetch(),
      wakatime.refetch(),
      browser.refetch(),
    ]).then(() => undefined)
  const data = snapshot.data
  useRuntimeRestartNotice(data?.health.instance_id, snapshot.dataUpdatedAt)

  return {
    data,
    snapshot,
    probe,
    wsl,
    wakatime,
    browser,
    // a failed read keeps the last sample: past a couple of missed polls a
    // Runtime that went away reads as 离线, not as the old 就绪 (one slow
    // read alone must not flash it — queries do not retry)
    connected:
      Boolean(data?.health.ready) &&
      !(snapshot.isError && Date.now() - snapshot.dataUpdatedAt > 12_000),
    eventReady: Boolean(probe.data),
    // Only true before the initial Runtime check has ever settled: a failed
    // remote poll retries every 5 s and must never flip useConsoleMode() back
    // to 'checking' (which flashed pages keyed by mode, 2026-11-27).
    loading:
      (snapshot.isPending &&
        snapshot.failureCount === 0 &&
        !snapshot.isFetched) ||
      (probe.isPending && probe.failureCount === 0 && !probe.isFetched),
    error: snapshot.error instanceof Error ? snapshot.error.message : undefined,
    refreshAll,
  }
}

export function RuntimeDataProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const value = useRuntimeDataQuery()
  return (
    <RuntimeDataContext.Provider value={value}>
      {children}
    </RuntimeDataContext.Provider>
  )
}

export function useRuntimeData() {
  const value = useContext(RuntimeDataContext)
  if (!value) {
    throw new Error('useRuntimeData must be used inside RuntimeDataProvider')
  }
  return value
}
