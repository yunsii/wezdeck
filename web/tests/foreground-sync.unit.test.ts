import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'

import {
  foregroundSyncKeys,
  foregroundSyncState,
} from '../src/features/foreground-sync'

describe('foreground sync', () => {
  it('leaves session queries to their views and keeps ticket detail warm', () => {
    expect(foregroundSyncKeys('/zh/console/sessions/a%2Fb')).toEqual([
      ['runtime', 'collab', 'health', {}],
      ['runtime', 'collab', 'list', { limit: 200 }],
    ])
    expect(foregroundSyncKeys('/console/collab/ticket-1').at(-1)).toEqual([
      'runtime',
      'collab',
      'show',
      { id: 'ticket-1' },
    ])
  })

  it('keeps the previous successful read when a refresh fails', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const key = ['remote', 'sessions']
    client.setQueryData(key, { sessions: [] }, { updatedAt: 1_000 })
    expect(foregroundSyncState(client, key)).toMatchObject({
      lastAt: 1_000,
      fresh: true,
      failed: false,
    })
    expect(foregroundSyncState(client, key, 1_500).fresh).toBe(false)

    await client
      .fetchQuery({
        queryKey: key,
        queryFn: () => Promise.reject(new Error('offline')),
        staleTime: 0,
      })
      .catch(() => undefined)
    expect(foregroundSyncState(client, key, 1_500)).toMatchObject({
      lastAt: 1_000,
      fresh: false,
      failed: true,
    })
  })

  it('treats an unsuccessful collab envelope as a failure', () => {
    const client = new QueryClient()
    const key = foregroundSyncKeys('/console/collab')[1]
    client.setQueryData(key, { ok: false }, { updatedAt: 1_000 })
    expect(foregroundSyncState(client, key)).toMatchObject({
      lastAt: 1_000,
      fresh: false,
      failed: true,
    })
  })
})
