import { describe, expect, it } from 'vitest'

import { diffSessionRows } from '#/features/session-list-trace'
import type { ListRowSig } from '#/features/session-list-trace'

const row = (
  key: string,
  status = 'idle',
  unread = 0,
  count = 1,
): ListRowSig => ({ key, status, unread, count })

describe('diffSessionRows', () => {
  it('reports no churn when order, membership and status are identical', () => {
    const a = [row('r1/a', 'waiting', 1), row('r1/b', 'running', 0)]
    expect(diffSessionRows(a, [...a])).toEqual({
      rows: 2,
      orderChanged: false,
      added: 0,
      removed: 0,
      statusChanged: 0,
    })
  })

  it('detects order swaps among common rows', () => {
    const prev = [row('r1/a'), row('r1/b'), row('r1/c')]
    const next = [row('r1/b'), row('r1/a'), row('r1/c')]
    expect(diffSessionRows(prev, next)).toEqual({
      rows: 3,
      orderChanged: true,
      added: 0,
      removed: 0,
      statusChanged: 0,
    })
  })

  it('tracks added, removed, and status/unread/groupCount changes without false orderChanged', () => {
    const prev = [row('r1/a', 'running', 0, 1), row('r1/b', 'idle', 0, 1)]
    const next = [row('r1/a', 'waiting', 1, 2), row('r1/c', 'idle', 0, 1)]
    expect(diffSessionRows(prev, next)).toEqual({
      rows: 2,
      orderChanged: false,
      added: 1,
      removed: 1,
      statusChanged: 1,
    })
  })
})
