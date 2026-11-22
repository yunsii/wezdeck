// Query cache persisted to IndexedDB (forge's pattern, docs/web-pwa.md): the
// installed app opens with the last tickets and refreshes in the background;
// when the host is offline the page shows them "as of" their fetch time.
// No IndexedDB (some private modes / in-app views) → no persistence, the app
// still works. Busted when the data contract changes, not on every deploy.
import { QueryClient } from '@tanstack/react-query'
import type { Query } from '@tanstack/react-query'
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { createStore, del, get, set } from 'idb-keyval'
import { useState } from 'react'

const MAX_AGE = 7 * 24 * 3600 * 1000

function createPersister() {
  if (typeof indexedDB === 'undefined') return null
  try {
    const store = createStore('wezdeck', 'query-cache')
    return createAsyncStoragePersister({
      key: 'wezdeck-query-cache',
      throttleTime: 1000,
      storage: {
        getItem: (key) =>
          get<string>(key, store).then(
            (value) => value ?? null,
            () => null,
          ),
        setItem: (key, value: string) =>
          set(key, value, store).catch(() => undefined),
        removeItem: (key) => del(key, store).catch(() => undefined),
      },
    })
  } catch {
    return null
  }
}

/**
 * Kept offline: collab reads and the remote session list / conversations,
 * so a session opens with its last messages at once and only the new ones
 * arrive (and stream in) after the refresh.
 */
const shouldPersist = (query: Query) =>
  query.state.status === 'success' &&
  ((query.queryKey[0] === 'runtime' && query.queryKey[1] === 'collab') ||
    query.queryKey[0] === 'remote')

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 2_000,
            gcTime: MAX_AGE,
            refetchOnWindowFocus: false,
            retry: false,
          },
        },
      }),
  )
  const [persister] = useState(createPersister)
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={
        persister
          ? {
              persister,
              maxAge: MAX_AGE,
              buster: __CACHE_BUSTER__,
              dehydrateOptions: { shouldDehydrateQuery: shouldPersist },
            }
          : { persister: noopPersister, maxAge: 0 }
      }
    >
      {children}
    </PersistQueryClientProvider>
  )
}

const noopPersister = {
  persistClient: async () => undefined,
  restoreClient: async () => undefined,
  removeClient: async () => undefined,
}
