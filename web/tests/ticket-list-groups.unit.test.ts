// covers: web/src/features/ticket-list-groups.ts
import { describe, expect, it } from 'vitest'

import type { CollabTicket } from '#/lib/runtime-contract'
import {
  bucketOpenGroups,
  buildTicketGroups,
  countTicketFilters,
  filterTicketGroups,
  flattenVisibleGroupIds,
  groupIsExpanded,
  normalizeTicketFilter,
} from '#/features/ticket-list-groups'

function makeTicket(overrides: Partial<CollabTicket>): CollabTicket {
  return {
    id: 'req-1',
    title: 'Sample',
    from: 'wezdeck',
    to: 'coco-forge',
    repos: [],
    status: 'in_progress',
    phase: null,
    owner: null,
    parent: null,
    kind: 'ticket',
    created_at: '2026-11-27T08:00:00Z',
    updated_at: '2026-11-27T08:00:00Z',
    worktree: null,
    branch: null,
    runs: 0,
    running: [],
    ...overrides,
  }
}

describe('ticket-list-groups (4-tab filtering, 3-tier bucketing, and folding)', () => {
  const parent = makeTicket({
    id: 'req-parent',
    kind: 'parent',
    title: 'Cross-repo auth migration',
    status: 'in_progress',
    updated_at: '2026-11-27T08:00:00Z',
  })
  const child1 = makeTicket({
    id: 'req-child-1',
    kind: 'child',
    parent: 'req-parent',
    title: 'Update backend tokens',
    status: 'shipped',
    created_at: '2026-11-27T08:01:00Z',
    updated_at: '2026-11-27T08:10:00Z',
  })
  const child2 = makeTicket({
    id: 'req-child-2',
    kind: 'child',
    parent: 'req-parent',
    title: 'Update frontend login',
    status: 'waiting_initiator',
    created_at: '2026-11-27T08:02:00Z',
    updated_at: '2026-11-27T08:20:00Z',
  })
  const internalDraft = makeTicket({
    id: 'req-draft-research',
    kind: 'research',
    parent: 'req-parent',
    title: 'Internal fanout draft scan',
    status: 'shipped',
    updated_at: '2026-11-27T08:03:00Z',
  })
  const standaloneResearch = makeTicket({
    id: 'req-research-1',
    kind: 'research',
    title: 'Investigate relay disconnect',
    status: 'in_progress',
    updated_at: '2026-11-27T08:30:00Z',
  })
  const failedTicket = makeTicket({
    id: 'req-failed-1',
    kind: 'ticket',
    title: 'Broken build run',
    status: 'failed',
    updated_at: '2026-11-27T07:30:00Z',
  })
  const closedStaleRunning = makeTicket({
    id: 'req-closed-dirty',
    kind: 'ticket',
    title: 'Closed ticket with stale running entry',
    status: 'closed',
    running: [{ run: 'run-stale' } as never],
    updated_at: '2026-11-27T07:15:00Z',
  })
  const doneTicket = makeTicket({
    id: 'req-done-1',
    kind: 'ticket',
    title: 'Fix typo',
    status: 'shipped',
    updated_at: '2026-11-27T07:00:00Z',
  })

  const all = [
    parent,
    child1,
    child2,
    internalDraft,
    standaloneResearch,
    failedTicket,
    closedStaleRunning,
    doneTicket,
  ]

  it('folds children under parent, hides internal draft research, and bubbles activity & counts', () => {
    const groups = buildTicketGroups(all)
    expect(groups.map((g) => g.root.id)).toEqual([
      'req-research-1',
      'req-parent',
      'req-failed-1',
      'req-closed-dirty',
      'req-done-1',
    ])

    const parentGroup = groups.find((g) => g.root.id === 'req-parent')!
    expect(parentGroup.children.map((c) => c.id)).toEqual([
      'req-child-1',
      'req-child-2',
    ])
    expect(parentGroup.summary).toEqual({
      total: 2,
      done: 1,
      running: 0,
      waiting: 1,
      failed: 0,
    })
    expect(parentGroup.activityAt).toBe(Date.parse('2026-11-27T08:20:00Z'))
  })

  it('keeps failed in open, excludes closed with stale running from open, and isolates research', () => {
    const groups = buildTicketGroups(all)
    const counts = countTicketFilters(groups)
    expect(counts).toEqual({
      open: 2, // parent + failedTicket
      research: 1, // standaloneResearch only (internalDraft hidden)
      ended: 2, // closedStaleRunning + doneTicket
      all: 5,
      inbox: 2, // parent (child waiting) + failedTicket
    })

    expect(
      filterTicketGroups(groups, 'open', '').map((g) => g.root.id),
    ).toEqual(['req-parent', 'req-failed-1'])
    expect(
      filterTicketGroups(groups, 'ended', '').map((g) => g.root.id),
    ).toEqual(['req-closed-dirty', 'req-done-1'])
    expect(
      filterTicketGroups(groups, 'research', '').map((g) => g.root.id),
    ).toEqual(['req-research-1'])
  })

  it('maps legacy stored filters (active/mine) smoothly onto open', () => {
    expect(normalizeTicketFilter('active')).toBe('open')
    expect(normalizeTicketFilter('mine')).toBe('open')
    expect(normalizeTicketFilter('open')).toBe('open')
    expect(normalizeTicketFilter('research')).toBe('research')
    expect(normalizeTicketFilter('ended')).toBe('ended')
    expect(normalizeTicketFilter('all')).toBe('all')
    expect(normalizeTicketFilter('inbox')).toBeNull()
    expect(normalizeTicketFilter('bogus')).toBeNull()
  })

  it('partitions open groups into attention -> running -> queued and folds >14d stale rows', () => {
    const now = Date.parse('2026-11-27T12:00:00Z')
    const daysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString()
    const groups = buildTicketGroups([
      makeTicket({
        id: 'req-queued',
        status: 'submitted',
        updated_at: daysAgo(1),
      }),
      makeTicket({
        id: 'req-running',
        status: 'in_progress',
        updated_at: daysAgo(2),
      }),
      makeTicket({
        id: 'req-attention',
        status: 'waiting_initiator',
        updated_at: daysAgo(3),
      }),
      makeTicket({
        id: 'req-failed',
        status: 'failed',
        updated_at: daysAgo(4),
      }),
      makeTicket({
        id: 'req-stale-waiting',
        status: 'waiting_initiator',
        updated_at: daysAgo(20),
      }),
      makeTicket({
        id: 'req-live-old',
        status: 'in_progress',
        running: [{ run: 'r-live' } as never],
        updated_at: daysAgo(25),
      }),
    ])

    const { buckets, older } = bucketOpenGroups(groups, now)
    expect(buckets.map((b) => [b.key, b.groups.map((g) => g.root.id)])).toEqual(
      [
        ['attention', ['req-attention', 'req-failed']],
        ['running', ['req-running', 'req-live-old']],
        ['queued', ['req-queued']],
      ],
    )
    expect(older.map((g) => g.root.id)).toEqual(['req-stale-waiting'])
  })

  it('auto-expands parent when child matches search or is waiting, and flattens visible IDs', () => {
    const groups = buildTicketGroups(all)
    const searchHit = filterTicketGroups(groups, 'all', 'frontend login')
    expect(searchHit).toHaveLength(1)
    expect(searchHit[0].root.id).toBe('req-parent')
    expect(searchHit[0].matchInChild).toBe(true)
    expect(groupIsExpanded(searchHit[0], { 'req-parent': false })).toBe(true)

    const visible = flattenVisibleGroupIds(groups, {})
    expect(visible).toEqual([
      'req-research-1',
      'req-parent',
      'req-child-1',
      'req-child-2',
      'req-failed-1',
      'req-closed-dirty',
      'req-done-1',
    ])

    expect(flattenVisibleGroupIds(groups, { 'req-parent': false })).toEqual([
      'req-research-1',
      'req-parent',
      'req-failed-1',
      'req-closed-dirty',
      'req-done-1',
    ])
    expect(
      flattenVisibleGroupIds(groups, { 'req-parent': false }, 'req-child-2'),
    ).toEqual([
      'req-research-1',
      'req-parent',
      'req-child-1',
      'req-child-2',
      'req-failed-1',
      'req-closed-dirty',
      'req-done-1',
    ])
  })
})
