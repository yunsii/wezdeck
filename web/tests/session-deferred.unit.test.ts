import { describe, expect, it } from 'vitest'
import { mergeDeferredPending } from '../src/features/session-deferred'
import type { DeferredRecord } from '../src/features/session-deferred'

const hostItem: DeferredRecord = {
  id: 'sent-20261128-100000-abc123',
  client_op: '11111111-1111-4111-8111-111111111111',
  session_id: 'session-1',
  pane: '%1',
  worktree: '/repo',
  text: 'Continue after the turn',
  policy: 'after_review',
  status: 'waiting_review',
  created_at: 100,
}

describe('host deferred projection', () => {
  it('replaces the optimistic bubble by client operation and survives a new page', () => {
    const optimistic = [
      {
        text: hostItem.text,
        at: 90,
        clientOp: hostItem.client_op,
        state: 'deferred' as const,
      },
    ]
    expect(mergeDeferredPending(optimistic, [hostItem])).toMatchObject([
      { deferredId: hostItem.id, state: 'waiting_review', text: hostItem.text },
    ])
    expect(mergeDeferredPending([], [hostItem])).toHaveLength(1)
  })

  it('keeps a locally submitting message until the host confirms it', () => {
    const local = [{ text: 'Uploading', at: 90, state: 'sending' as const }]
    expect(mergeDeferredPending(local, [])).toEqual(local)
    expect(
      mergeDeferredPending([], [hostItem], new Set([hostItem.id])),
    ).toEqual([])
  })

  it('drops a local deferred bubble once the host reports an empty queue', () => {
    const old = [
      {
        text: hostItem.text,
        at: 90,
        deferredId: hostItem.id,
        clientOp: hostItem.client_op,
        state: 'deferred' as const,
      },
    ]
    expect(mergeDeferredPending(old, [], undefined, 100)).toEqual([])
  })

  it('keeps a newly accepted bubble through a stale in-flight host read', () => {
    const local = [
      {
        text: hostItem.text,
        at: 90,
        acceptedAt: 100,
        deferredId: hostItem.id,
        clientOp: hostItem.client_op,
        state: 'deferred' as const,
      },
    ]
    expect(mergeDeferredPending(local, [], undefined, 99)).toEqual(local)
    expect(mergeDeferredPending(local, [], undefined, 101)).toEqual([])
  })
})
