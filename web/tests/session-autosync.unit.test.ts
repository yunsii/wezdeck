import { describe, expect, it } from 'vitest'

import {
  AUTO_SYNC_RETRY_MS,
  isCacheCurrent,
  pickAutoSyncTargets,
  syncSignature,
} from '#/features/session-autosync'
import type { SessionCard } from '#/features/session-card'

const card = (over: Partial<SessionCard>): SessionCard => ({
  id: 's1',
  agent: 'claude',
  name: 'claude',
  window: '',
  cwd: '/r/a',
  branch: 'master',
  status: 'idle',
  last_prompt: '',
  ts: 1_000,
  transcript: true,
  desk_idle_s: 0,
  ...over,
})

describe('session autosync planner', () => {
  it('picks waiting and done sessions only, prioritizing waiting then newest ts', () => {
    const sessions = [
      card({ id: 'idle-1', status: 'idle', ts: 9_000 }),
      card({ id: 'run-1', status: 'running', ts: 8_000 }),
      card({ id: 'done-old', status: 'done', ts: 2_000 }),
      card({ id: 'done-new', status: 'done', ts: 5_000 }),
      card({
        id: 'wait-old',
        status: 'waiting',
        waiting_kind: 'permission',
        ts: 1_000,
      }),
      card({
        id: 'wait-new',
        status: 'waiting',
        waiting_kind: 'ask',
        ts: 3_000,
      }),
      card({
        id: 'restarting',
        status: 'done',
        restart_pending: true,
        ts: 9_999,
      }),
    ]

    const { targets } = pickAutoSyncTargets({
      sessions,
      synced: new Map(),
      inFlight: new Set(),
      failedAt: new Map(),
      getCached: () => undefined,
    })

    expect(targets.map((item) => item.id)).toEqual([
      'wait-new',
      'wait-old',
      'done-new',
      'done-old',
    ])
    expect(targets.every((item) => item.reason === 'cold')).toBe(true)
  })

  it('skips the active session, already-synced signatures, in-flight items, and recent failures', () => {
    const doneA = card({ id: 'done-a', status: 'done', ts: 100 })
    const doneB = card({ id: 'done-b', status: 'done', ts: 200 })
    const waitA = card({
      id: 'wait-a',
      status: 'waiting',
      waiting_kind: 'permission',
      ts: 300,
    })
    const waitB = card({ id: 'wait-b', status: 'waiting', ts: 400 })
    const now = 50_000

    const { targets } = pickAutoSyncTargets({
      sessions: [doneA, doneB, waitA, waitB],
      activeId: 'wait-b',
      synced: new Map([[doneA.id, syncSignature(doneA)]]),
      inFlight: new Set([doneB.id]),
      failedAt: new Map([
        [`${waitA.id}|${syncSignature(waitA)}`, now - AUTO_SYNC_RETRY_MS + 100],
      ]),
      getCached: () => undefined,
      now,
    })

    expect(targets).toEqual([])

    // once the retry window expires, the failed session becomes eligible again
    const retry = pickAutoSyncTargets({
      sessions: [waitA],
      synced: new Map(),
      inFlight: new Set(),
      failedAt: new Map([
        [`${waitA.id}|${syncSignature(waitA)}`, now - AUTO_SYNC_RETRY_MS],
      ]),
      getCached: () => undefined,
      now,
    })
    expect(retry.targets.map((item) => item.id)).toEqual(['wait-a'])
  })

  it('marks persisted current caches as alreadyCurrent and refetches stale ones', () => {
    const fresh = card({ id: 'fresh', status: 'done', ts: 1_000 })
    const staleTs = card({ id: 'stale-ts', status: 'done', ts: 2_000 })
    const staleStatus = card({
      id: 'stale-status',
      status: 'waiting',
      waiting_kind: 'ask',
      ts: 1_000,
    })
    const emptyMsgs = card({
      id: 'empty-msgs',
      status: 'done',
      ts: 1_000,
      transcript: true,
    })

    const msg = { role: 'assistant' as const, text: 'done' }
    const cache = new Map([
      [
        'fresh',
        { status: 'done', waiting_kind: '', ts: 1_000, messages: [msg] },
      ],
      [
        'stale-ts',
        { status: 'done', waiting_kind: '', ts: 1_500, messages: [msg] },
      ],
      [
        'stale-status',
        { status: 'running', waiting_kind: '', ts: 1_000, messages: [msg] },
      ],
      [
        'empty-msgs',
        { status: 'done', waiting_kind: '', ts: 1_000, messages: [] },
      ],
    ])

    expect(isCacheCurrent(cache.get('fresh'), fresh)).toBe(true)
    expect(isCacheCurrent(cache.get('stale-ts'), staleTs)).toBe(false)
    expect(isCacheCurrent(cache.get('stale-status'), staleStatus)).toBe(false)
    expect(isCacheCurrent(cache.get('empty-msgs'), emptyMsgs)).toBe(false)

    const result = pickAutoSyncTargets({
      sessions: [fresh, staleTs, staleStatus, emptyMsgs],
      synced: new Map(),
      inFlight: new Set(),
      failedAt: new Map(),
      getCached: (id) => cache.get(id),
    })

    expect(result.alreadyCurrent).toEqual([
      { id: 'fresh', sig: syncSignature(fresh) },
    ])
    expect(result.targets).toEqual([
      {
        id: 'stale-status',
        sig: syncSignature(staleStatus),
        status: 'waiting',
        reason: 'stale',
      },
      {
        id: 'stale-ts',
        sig: syncSignature(staleTs),
        status: 'done',
        reason: 'stale',
      },
      {
        id: 'empty-msgs',
        sig: syncSignature(emptyMsgs),
        status: 'done',
        reason: 'stale',
      },
    ])
  })

  it('caps the sweep at the configured limit', () => {
    const sessions = Array.from({ length: 5 }, (_, i) =>
      card({ id: `s-${i}`, status: 'done', ts: 1_000 + i }),
    )
    const { targets } = pickAutoSyncTargets({
      sessions,
      synced: new Map(),
      inFlight: new Set(),
      failedAt: new Map(),
      getCached: () => undefined,
      limit: 2,
    })
    expect(targets.map((item) => item.id)).toEqual(['s-4', 's-3'])
  })
})
