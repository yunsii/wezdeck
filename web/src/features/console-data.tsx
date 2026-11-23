import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import { createContext, useContext, useEffect } from 'react'

import {
  getRuntimeSnapshot,
  getWslBridgeStatus,
  getWakatimeStatus,
  probeRuntime,
  runtimeEventsUrl,
} from '#/lib/runtime-client'

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
    ]).then(() => undefined)
  const data = snapshot.data

  return {
    data,
    snapshot,
    probe,
    wsl,
    wakatime,
    connected: Boolean(data?.health.ready),
    eventReady: Boolean(probe.data),
    loading: snapshot.isPending || probe.isPending,
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
