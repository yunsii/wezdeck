// Collab reads for the PWA views. A failed read (host offline, link down)
// throws instead of returning the {ok:false} envelope whenever good data is
// already cached, so TanStack keeps showing the last tickets (persisted to
// IndexedDB) and the page can say "as of HH:MM" instead of going blank.
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'

import {
  applyCollabHealthOverlay,
  applyCollabListOverlay,
  applyCollabShowOverlay,
  reconcileTicketList,
  reconcileTicketShow,
  useAllTicketOptimistics,
} from './optimistic-tickets'
import { getCollab } from './runtime-client'
import type { CollabCommand } from './runtime-client'
import type { CollabHealth, CollabList, CollabShow } from './runtime-contract'

type Params = Record<string, string | number | undefined>

export function collabKey(command: CollabCommand, params: Params = {}) {
  return ['runtime', 'collab', command, params] as const
}

export function useCollab<TCommand extends CollabCommand>(
  command: TCommand,
  params: Params = {},
  options: {
    refetchInterval?: number
    enabled?: boolean
    staleTime?: number
    /** while a new key loads, keep returning the last data (isPlaceholderData) */
    keepPrevious?: boolean
  } = {},
) {
  const client = useQueryClient()
  const key = collabKey(command, params)
  const overlays = useAllTicketOptimistics()
  const showId =
    command === 'show' && typeof params.id === 'string' ? params.id : undefined

  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      const result = await getCollab(command, params)
      if (!result.ok && client.getQueryData(key)) {
        throw new Error(result.error?.message ?? 'unavailable')
      }
      return result
    },
    enabled: options.enabled ?? typeof window !== 'undefined',
    refetchInterval: options.refetchInterval,
    staleTime: options.staleTime,
    placeholderData: options.keepPrevious ? keepPreviousData : undefined,
  })

  useEffect(() => {
    if (!query.data || overlays.size === 0) return
    if (command === 'show' && showId) {
      const listRow = client
        .getQueryData<CollabList>(collabKey('list', {}))
        ?.tickets.find((row) => row.id === showId)
      reconcileTicketShow(showId, query.data as CollabShow, Date.now(), {
        listRow,
      })
    } else if (command === 'list') {
      reconcileTicketList(query.data as CollabList, Date.now(), {
        getShow: (tid) =>
          client.getQueryData<CollabShow>(collabKey('show', { id: tid })),
      })
    }
  }, [client, command, showId, query.data, overlays])

  const projected = useMemo(() => {
    const raw = query.data
    if (!raw || overlays.size === 0) return raw
    if (command === 'show' && showId) {
      return (applyCollabShowOverlay(raw as CollabShow, overlays.get(showId)) ??
        raw) as typeof raw
    }
    if (command === 'list') {
      return (applyCollabListOverlay(raw as CollabList, overlays) ??
        raw) as typeof raw
    }
    if (command === 'health') {
      return (applyCollabHealthOverlay(raw as CollabHealth, overlays) ??
        raw) as typeof raw
    }
    return raw
  }, [query.data, command, showId, overlays])

  return projected === query.data ? query : { ...query, data: projected }
}
