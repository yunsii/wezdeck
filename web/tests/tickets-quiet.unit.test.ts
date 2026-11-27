import { describe, expect, it } from 'vitest'

import {
  bucketOpenGroups,
  buildTicketGroups,
} from '../src/features/ticket-list-groups'
import type { CollabTicket } from '../src/lib/runtime-contract'

const now = Date.parse('2026-11-23T12:00:00Z')
const days = (n: number) => new Date(now - n * 86_400_000).toISOString()
const ticket = (
  id: string,
  updated: string,
  extra: Partial<CollabTicket> = {},
) =>
  ({
    id,
    updated_at: updated,
    running: [],
    status: 'submitted',
    ...extra,
  }) as unknown as CollabTicket

describe('stale open tickets fold after 14 days', () => {
  it('splits on 14 days without activity', () => {
    const groups = buildTicketGroups([
      ticket('new', days(1)),
      ticket('old', days(19)),
      ticket('edge', days(13.9)),
    ])
    const { buckets, older } = bucketOpenGroups(groups, now)
    expect(buckets.flatMap((b) => b.groups.map((g) => g.root.id))).toEqual([
      'new',
      'edge',
    ])
    expect(older.map((g) => g.root.id)).toEqual(['old'])
  })

  it('never folds a ticket with a live run or live manager session', () => {
    const groups = buildTicketGroups([
      ticket('running', days(30), { running: [{ run: 'r1' }] as never }),
      ticket('live-mgr', days(30), {
        manager_session: { state: 'live' },
      }),
      ticket('stale-waiting', days(30), { status: 'waiting_initiator' }),
    ])
    const { buckets, older } = bucketOpenGroups(groups, now)
    expect(buckets.flatMap((b) => b.groups.map((g) => g.root.id))).toEqual([
      'running',
      'live-mgr',
    ])
    expect(older.map((g) => g.root.id)).toEqual(['stale-waiting'])
  })
})
