import { describe, expect, it } from 'vitest'

import type { CollabShow } from '#/lib/runtime-contract'
import { buildTicketSteps } from '#/features/ticket-pipeline'
import { isLifecycleEvent } from '#/features/ticket-timeline'

function makeShow(overrides: {
  ticket?: Partial<NonNullable<CollabShow['ticket']>>
  collab?: CollabShow['collab']
  children_detail?: CollabShow['children_detail']
  proposals?: CollabShow['proposals']
  runs?: CollabShow['runs']
}): CollabShow {
  return {
    v: 1,
    ok: true,
    ticket: {
      id: 'req-20261127-000000-aaaaaa',
      title: 'Test ticket',
      from: 'fe1',
      to: 'repo-a',
      status: 'submitted',
      phase: null,
      owner: 'initiator',
      parent: null,
      kind: 'ticket',
      created_at: '2026-11-27T00:00:00Z',
      updated_at: '2026-11-27T00:00:00Z',
      worktree: null,
      branch: null,
      progress: null,
      last_milestone: null,
      runs: 0,
      running: [],
      last_run: null,
      ...overrides.ticket,
    },
    sessions: {},
    sections: [],
    children: (overrides.children_detail ?? []).map((c) => c.id),
    children_detail: overrides.children_detail ?? [],
    collab: overrides.collab ?? null,
    runs: overrides.runs ?? [],
    proposals: overrides.proposals ?? [],
  }
}

describe('buildTicketSteps', () => {
  it('parent: plan_review highlights approval waiting', () => {
    const steps = buildTicketSteps(
      makeShow({
        ticket: {
          kind: 'parent',
          status: 'waiting_initiator',
          phase: 'plan_review',
        },
        collab: {
          kind: 'parent',
          contract_sha256: 'abc',
          scheduler: { alive: false, pid: null },
        },
      }),
    )
    expect(steps.map((s) => [s.id, s.tone, Boolean(s.current)])).toEqual([
      ['plan', 'done', false],
      ['review', 'waiting', true],
      ['dispatch', 'muted', false],
      ['merge', 'muted', false],
      ['verify', 'muted', false],
      ['done', 'muted', false],
    ])
  })

  it('parent: running with live scheduler reports child progress count', () => {
    const baseChild = makeShow({}).ticket!
    const steps = buildTicketSteps(
      makeShow({
        ticket: { kind: 'parent', status: 'in_progress', phase: 'running' },
        collab: {
          kind: 'parent',
          contract_sha256: 'abc',
          scheduler: { alive: true, pid: 123 },
        },
        children_detail: [
          {
            ...baseChild,
            id: 'req-1',
            status: 'shipped',
            depends_on: [],
            scope: [],
          },
          {
            ...baseChild,
            id: 'req-2',
            status: 'in_progress',
            running: ['run-1'],
            depends_on: [],
            scope: [],
          },
          {
            ...baseChild,
            id: 'req-3',
            status: 'submitted',
            depends_on: ['req-2'],
            scope: [],
          },
        ],
      }),
    )
    const dispatch = steps.find((s) => s.id === 'dispatch')
    expect(dispatch).toEqual({
      id: 'dispatch',
      tone: 'running',
      count: '1/3',
      current: true,
    })
  })

  it('parent: integration_conflict and verify_failed mark exact failed stages', () => {
    const conflict = buildTicketSteps(
      makeShow({
        ticket: {
          kind: 'parent',
          status: 'waiting_initiator',
          phase: 'integration_conflict',
        },
        collab: { kind: 'parent', contract_sha256: 'abc' },
      }),
    )
    expect(conflict.find((s) => s.id === 'merge')).toMatchObject({
      tone: 'error',
      current: true,
    })
    const verifyFail = buildTicketSteps(
      makeShow({
        ticket: {
          kind: 'parent',
          status: 'waiting_initiator',
          phase: 'verify_failed',
        },
        collab: { kind: 'parent', contract_sha256: 'abc' },
      }),
    )
    expect(verifyFail.find((s) => s.id === 'merge')?.tone).toBe('done')
    expect(verifyFail.find((s) => s.id === 'verify')).toMatchObject({
      tone: 'error',
      current: true,
    })
  })

  it('parent: done_unmerged completes without marking merge/verify done', () => {
    const steps = buildTicketSteps(
      makeShow({
        ticket: { kind: 'parent', status: 'shipped', phase: 'done_unmerged' },
        collab: { kind: 'parent', contract_sha256: 'abc' },
      }),
    )
    expect(steps.find((s) => s.id === 'dispatch')?.tone).toBe('done')
    expect(steps.find((s) => s.id === 'merge')?.tone).toBe('muted')
    expect(steps.find((s) => s.id === 'verify')?.tone).toBe('muted')
    expect(steps.find((s) => s.id === 'done')).toMatchObject({
      tone: 'done',
      current: true,
    })
  })

  it('research: maps running and shipped phases', () => {
    const running = buildTicketSteps(
      makeShow({
        ticket: {
          kind: 'research',
          status: 'in_progress',
          phase: 'researching',
          running: ['run-1'],
        },
      }),
    )
    expect(running.map((s) => [s.id, s.tone])).toEqual([
      ['checkout', 'done'],
      ['research', 'running'],
      ['done', 'muted'],
    ])
    const done = buildTicketSteps(
      makeShow({
        ticket: { kind: 'research', status: 'shipped', phase: 'research_done' },
      }),
    )
    expect(done.map((s) => [s.id, s.tone])).toEqual([
      ['checkout', 'done'],
      ['research', 'done'],
      ['done', 'done'],
    ])
  })

  it('child/ticket: tracks queued, researching, implementing, and shipped', () => {
    const queued = buildTicketSteps(
      makeShow({
        ticket: {
          status: 'submitted',
          progress: {
            step: 'queued',
            message: 'waiting on mem',
            ts: '2026-11-27T00:00:00Z',
          },
        },
      }),
    )
    expect(queued.find((s) => s.id === 'submitted')).toMatchObject({
      tone: 'waiting',
      current: true,
    })

    const impl = buildTicketSteps(
      makeShow({
        ticket: {
          status: 'in_progress',
          phase: 'implementing',
          worktree: '/tmp/wt',
          running: ['run-2'],
        },
      }),
    )
    expect(impl.map((s) => [s.id, s.tone, Boolean(s.current)])).toEqual([
      ['submitted', 'done', false],
      ['worktree', 'done', false],
      ['research', 'done', false],
      ['implement', 'running', true],
      ['done', 'muted', false],
    ])
  })
})

describe('isLifecycleEvent', () => {
  it('hides per-tool chatter and keeps scheduling / lifecycle events', () => {
    expect(isLifecycleEvent({ kind: 'tool' })).toBe(false)
    expect(isLifecycleEvent({ kind: 'session_init' })).toBe(false)
    expect(isLifecycleEvent({ kind: 'scheduler_start' })).toBe(true)
    expect(isLifecycleEvent({ kind: 'queued' })).toBe(true)
    expect(isLifecycleEvent({ kind: 'dispatched' })).toBe(true)
    expect(isLifecycleEvent({ kind: 'milestone' })).toBe(true)
    expect(isLifecycleEvent({ kind: 'merge' })).toBe(true)
    expect(isLifecycleEvent({ kind: 'verify' })).toBe(true)
  })
})
