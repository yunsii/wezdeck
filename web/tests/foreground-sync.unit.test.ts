import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'

import {
  foregroundSyncKeys,
  foregroundSyncState,
} from '../src/features/foreground-sync'

describe('foreground sync', () => {
  it('includes the open detail in the app status', () => {
    expect(foregroundSyncKeys('/zh/console/sessions/a%2Fb').at(-1)).toEqual([
      'remote',
      'session',
      'a/b',
    ])
    expect(foregroundSyncKeys('/console/collab/ticket-1').at(-1)).toEqual([
      'runtime',
      'collab',
      'show',
      { id: 'ticket-1' },
    ])
  })

  it('uses the oldest successful read and keeps it when a refresh fails', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const keys = foregroundSyncKeys('/console/sessions')
    keys.forEach((key, index) =>
      client.setQueryData(
        key,
        { ok: true },
        { updatedAt: 1_000 + index * 100 },
      ),
    )
    expect(foregroundSyncState(client, keys)).toMatchObject({
      lastAt: 1_000,
      fresh: true,
      failed: false,
    })
    expect(foregroundSyncState(client, keys, 1_500).fresh).toBe(false)

    await client
      .fetchQuery({
        queryKey: keys[0],
        queryFn: () => Promise.reject(new Error('offline')),
        staleTime: 0,
      })
      .catch(() => undefined)
    expect(foregroundSyncState(client, keys, 1_500)).toMatchObject({
      lastAt: 1_000,
      fresh: false,
      failed: true,
    })
  })

  it('treats an unsuccessful collab envelope as a failure', () => {
    const client = new QueryClient()
    const keys = foregroundSyncKeys('/console/collab')
    keys.forEach((key) => client.setQueryData(key, { ok: true }))
    client.setQueryData(keys[1], { ok: false })
    expect(foregroundSyncState(client, keys)).toMatchObject({
      lastAt: 0,
      fresh: false,
      failed: true,
    })
  })
})
