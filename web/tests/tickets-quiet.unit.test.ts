import { describe, expect, it } from 'vitest'

import { splitQuiet } from '../src/features/tickets-view'
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

describe('quiet tickets fold under 较早', () => {
  it('splits on a week without activity', () => {
    const { recent, older } = splitQuiet(
      [
        ticket('new', days(1)),
        ticket('old', days(19)),
        ticket('edge', days(6.9)),
      ],
      now,
    )
    expect(recent.map((t) => t.id)).toEqual(['new', 'edge'])
    expect(older.map((t) => t.id)).toEqual(['old'])
  })
  it('never folds one that runs or waits on you', () => {
    const { older } = splitQuiet(
      [
        ticket('running', days(30), { running: [{ run: 'r1' }] as never }),
        ticket('yours', days(30), { status: 'waiting_initiator' }),
      ],
      now,
    )
    expect(older).toEqual([])
  })
})
