// Collab reads for the PWA views. A failed read (host offline, link down)
// throws instead of returning the {ok:false} envelope whenever good data is
// already cached, so TanStack keeps showing the last tickets (persisted to
// IndexedDB) and the page can say "as of HH:MM" instead of going blank.
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'

import { getCollab } from './runtime-client'
import type { CollabCommand } from './runtime-client'

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
  return useQuery({
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
}
