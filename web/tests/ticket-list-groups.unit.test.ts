// covers: web/src/features/ticket-list-groups.ts
import { describe, expect, it } from 'vitest'

import type { CollabTicket } from '#/lib/runtime-contract'
import {
  buildTicketGroups,
  countTicketFilters,
  filterTicketGroups,
  flattenVisibleGroupIds,
  groupIsExpanded,
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

describe('ticket-list-groups (3+1 folding and research separation)', () => {
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
    doneTicket,
  ]

  it('folds children under parent, hides internal draft research, and bubbles activity & counts', () => {
    const groups = buildTicketGroups(all)
    // Only 3 top-level groups: standaloneResearch, parent, doneTicket
    expect(groups.map((g) => g.root.id)).toEqual([
      'req-research-1',
      'req-parent',
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
    // Parent inherits newest child activity timestamp (08:20 > 08:00)
    expect(parentGroup.activityAt).toBe(Date.parse('2026-11-27T08:20:00Z'))
  })

  it('separates standalone research out of active/ended and bubbles waiting child to mine', () => {
    const groups = buildTicketGroups(all)
    const counts = countTicketFilters(groups)
    expect(counts).toEqual({
      all: 3,
      active: 1, // parent only (research excluded from active)
      mine: 1, // parent (child2 waiting_initiator)
      research: 1, // standaloneResearch only (internalDraft hidden)
      ended: 1, // doneTicket
      inbox: 1, // parent (child2 waiting)
    })

    expect(
      filterTicketGroups(groups, 'active', '').map((g) => g.root.id),
    ).toEqual(['req-parent'])
    expect(
      filterTicketGroups(groups, 'research', '').map((g) => g.root.id),
    ).toEqual(['req-research-1'])
  })

  it('auto-expands parent when child matches search or is waiting, and flattens visible IDs', () => {
    const groups = buildTicketGroups(all)
    const searchHit = filterTicketGroups(groups, 'all', 'frontend login')
    expect(searchHit).toHaveLength(1)
    expect(searchHit[0].root.id).toBe('req-parent')
    expect(searchHit[0].matchInChild).toBe(true)
    expect(groupIsExpanded(searchHit[0], { 'req-parent': false })).toBe(true)

    // Waiting child auto-expands parent when no explicit toggle stored
    const visible = flattenVisibleGroupIds(groups, {})
    expect(visible).toEqual([
      'req-research-1',
      'req-parent',
      'req-child-1',
      'req-child-2',
      'req-done-1',
    ])

    // Explicit collapse hides children unless one of them is selected
    expect(flattenVisibleGroupIds(groups, { 'req-parent': false })).toEqual([
      'req-research-1',
      'req-parent',
      'req-done-1',
    ])
    expect(
      flattenVisibleGroupIds(groups, { 'req-parent': false }, 'req-child-2'),
    ).toEqual([
      'req-research-1',
      'req-parent',
      'req-child-1',
      'req-child-2',
      'req-done-1',
    ])
  })
})
