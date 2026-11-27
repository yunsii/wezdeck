import { describe, expect, it } from 'vitest'

import type { CollabShow, CollabTicket } from '#/lib/runtime-contract'
import {
  TICKET_AUTO_SYNC_RETRY_MS,
  isTicketCacheCurrent,
  needsTicketAutoSync,
  pickTicketAutoSyncTargets,
  ticketSyncSignature,
} from '#/features/ticket-autosync'

function ticket(
  id: string,
  overrides: Partial<CollabTicket> = {},
): CollabTicket {
  return {
    id,
    title: id,
    status: 'submitted',
    from: 'repo-a',
    to: 'repo-b',
    updated_at: '2026-11-27T01:00:00Z',
    running: [],
    ...overrides,
  } as CollabTicket
}

function show(row: CollabTicket, ok = true): Pick<CollabShow, 'ok' | 'ticket'> {
  return { ok, ticket: row }
}

describe('ticket-autosync', () => {
  it('selects waiting_initiator before running, newest updated_at first, skipping active and quiet tickets', () => {
    const waitingOld = ticket('req-wait-old', {
      status: 'waiting_initiator',
      updated_at: '2026-11-27T01:00:00Z',
    })
    const waitingNew = ticket('req-wait-new', {
      status: 'waiting_initiator',
      updated_at: '2026-11-27T02:00:00Z',
    })
    const running = ticket('req-run', {
      status: 'in_progress',
      running: ['run-1'],
      updated_at: '2026-11-27T03:00:00Z',
    })
    const active = ticket('req-active', {
      status: 'waiting_initiator',
      updated_at: '2026-11-27T04:00:00Z',
    })
    const quiet = ticket('req-quiet', { status: 'shipped' })

    expect(needsTicketAutoSync(waitingNew)).toBe(true)
    expect(needsTicketAutoSync(running)).toBe(true)
    expect(needsTicketAutoSync(quiet)).toBe(false)

    const { targets } = pickTicketAutoSyncTargets({
      tickets: [quiet, running, waitingOld, active, waitingNew],
      activeId: 'req-active',
      synced: new Map(),
      inFlight: new Set(),
      failedAt: new Map(),
      getCached: () => undefined,
    })

    expect(targets.map((item) => [item.id, item.status, item.reason])).toEqual([
      ['req-wait-new', 'waiting_initiator', 'cold'],
      ['req-wait-old', 'waiting_initiator', 'cold'],
      ['req-run', 'running', 'cold'],
    ])
  })

  it('marks up-to-date cache entries as alreadyCurrent and re-syncs stale ones', () => {
    const fresh = ticket('req-fresh', {
      status: 'waiting_initiator',
      updated_at: '2026-11-27T02:00:00Z',
    })
    const stale = ticket('req-stale', {
      status: 'waiting_initiator',
      updated_at: '2026-11-27T03:00:00Z',
    })
    const olderCached = ticket('req-stale', {
      status: 'waiting_initiator',
      updated_at: '2026-11-27T02:00:00Z',
    })

    expect(isTicketCacheCurrent(show(fresh), fresh)).toBe(true)
    expect(isTicketCacheCurrent(show(olderCached), stale)).toBe(false)

    const { targets, alreadyCurrent } = pickTicketAutoSyncTargets({
      tickets: [fresh, stale],
      synced: new Map(),
      inFlight: new Set(),
      failedAt: new Map(),
      getCached: (id) => (id === 'req-fresh' ? show(fresh) : show(olderCached)),
    })

    expect(alreadyCurrent).toEqual([
      { id: 'req-fresh', sig: ticketSyncSignature(fresh) },
    ])
    expect(targets).toEqual([
      {
        id: 'req-stale',
        sig: ticketSyncSignature(stale),
        status: 'waiting_initiator',
        reason: 'stale',
      },
    ])
  })

  it('honors synced watermark, inFlight set, and failure backoff window', () => {
    const row = ticket('req-1', { status: 'waiting_initiator' })
    const sig = ticketSyncSignature(row)
    const now = 100_000

    expect(
      pickTicketAutoSyncTargets({
        tickets: [row],
        synced: new Map([['req-1', sig]]),
        inFlight: new Set(),
        failedAt: new Map(),
        getCached: () => undefined,
        now,
      }).targets,
    ).toEqual([])

    expect(
      pickTicketAutoSyncTargets({
        tickets: [row],
        synced: new Map(),
        inFlight: new Set(['req-1']),
        failedAt: new Map(),
        getCached: () => undefined,
        now,
      }).targets,
    ).toEqual([])

    expect(
      pickTicketAutoSyncTargets({
        tickets: [row],
        synced: new Map(),
        inFlight: new Set(),
        failedAt: new Map([['req-1|' + sig, now - 1_000]]),
        getCached: () => undefined,
        now,
      }).targets,
    ).toEqual([])

    expect(
      pickTicketAutoSyncTargets({
        tickets: [row],
        synced: new Map(),
        inFlight: new Set(),
        failedAt: new Map([
          ['req-1|' + sig, now - TICKET_AUTO_SYNC_RETRY_MS - 1],
        ]),
        getCached: () => undefined,
        now,
      }).targets,
    ).toHaveLength(1)
  })
})
