import { describe, expect, it } from 'vitest'

import { LOST_AFTER_MS, settle, settleMatches } from '#/features/chat-thread'
import type { Message, Pending } from '#/features/chat-thread'
import { mergeOutboxPending } from '#/features/session-send'
import type { SentRecord } from '#/features/sent-history'

const ask = (text: string): Message => ({ role: 'user', text })
const say = (text: string): Message => ({ role: 'assistant', text })
const NOW = 1_000_000
const sent = (text: string, after: number, extra: Partial<Pending> = {}) =>
  ({
    text,
    at: NOW - 1_000 + after,
    after,
    state: 'queued',
    ...extra,
  }) as Pending

describe('settle (optimistic sends leave once the transcript shows them)', () => {
  it('keeps a queued message until the transcript has it', () => {
    const pending = [sent('look at the log', 2)]
    const before = [say('a'), say('b')]
    expect(settle(pending, before, 0, true, NOW)).toHaveLength(1)
    expect(
      settle(pending, [...before, ask('look at the log')], 0, true, NOW),
    ).toEqual([])
  })

  it('settles in whatever order the agent picks them up', () => {
    const pending = [sent('first', 1), sent('second', 1)]
    const picked = [say('a'), ask('second')]
    expect(settle(pending, picked, 0, true, NOW).map((p) => p.text)).toEqual([
      'first',
    ])
  })

  it('an earlier identical message does not settle a new one', () => {
    const pending = [sent('继续', 3)]
    const history = [ask('继续'), say('ok'), say('done')]
    expect(settle(pending, history, 0, true, NOW)).toHaveLength(1)
  })

  it('two identical messages need two transcript lines', () => {
    const pending = [sent('继续', 1), sent('继续', 1, { at: NOW - 500 })]
    const one = [say('a'), ask('继续')]
    expect(settle(pending, one, 0, true, NOW)).toHaveLength(1)
    expect(settle(pending, [...one, ask('继续')], 0, true, NOW)).toEqual([])
  })

  it('uses absolute indices when earlier pages are not loaded', () => {
    const pending = [sent('hi', 101)]
    // messages[0] is transcript index 100; index 101 is the new line
    expect(settle(pending, [say('x'), ask('hi')], 100, true, NOW)).toEqual([])
    expect(settle(pending, [ask('hi'), say('x')], 100, true, NOW)).toHaveLength(
      1,
    )
  })

  it('matches the host attachment note after the typed text', () => {
    const pending = [sent('see this', 0)]
    expect(
      settle(pending, [ask('see this\n\n[手机附件] /tmp/a.jpg')], 0, true, NOW),
    ).toEqual([])
  })

  it('never turns lost while the agent works; a minute after, once idle', () => {
    const old = [sent('queued long ago', 0, { at: NOW - 10 * 60_000 })]
    expect(settle(old, [], 0, true, NOW)[0].state).toBe('queued')
    // not dropped silently any more: it stays, marked 未送达
    const idle = settle(old, [], 0, false, NOW)
    expect(idle).toHaveLength(1)
    expect(idle[0].state).toBe('lost')
    const fresh = [sent('just now', 0, { at: NOW - 5_000 })]
    expect(settle(fresh, [], 0, false, NOW)[0].state).toBe('queued')
  })

  it('turns lost exactly at LOST_AFTER_MS', () => {
    const edge = (age: number) =>
      settle([sent('x', 0, { at: NOW - age })], [], 0, false, NOW)[0].state
    expect(edge(LOST_AFTER_MS - 1)).toBe('queued')
    expect(edge(LOST_AFTER_MS)).toBe('lost')
  })

  it('a lost message the transcript shows later still settles', () => {
    const old = [sent('late pickup', 1, { at: NOW - 5 * 60_000 })]
    expect(settle(old, [say('a')], 0, false, NOW)[0].state).toBe('lost')
    expect(settle(old, [say('a'), ask('late pickup')], 0, false, NOW)).toEqual(
      [],
    )
  })

  it('does not mutate the stored bubble when marking it lost', () => {
    const stored = sent('keep me queued', 0, { at: NOW - 5 * 60_000 })
    settle([stored], [], 0, false, NOW)
    expect(stored.state).toBe('queued')
  })

  it('a message still sending never expires', () => {
    const slow = [
      sent('slow host', 0, { at: NOW - 5 * 60_000, state: 'sending' }),
    ]
    expect(settle(slow, [], 0, false, NOW)).toHaveLength(1)
  })

  it('reports which transcript line took each bubble (it solidifies in place)', () => {
    const pending = [sent('first', 11), sent('second', 11)]
    const shown = [say('a'), ask('second')]
    const { left, took } = settleMatches(pending, shown, 10, true, NOW)
    expect(left.map((p) => p.text)).toEqual(['first'])
    expect([...took]).toEqual([11])
  })

  it('matches terminal-merged drafts and never settles failed records', () => {
    const merged = [sent('fix the scroll jump', 0)]
    expect(
      settle(merged, [ask('顺便 fix the scroll jump 谢谢')], 0, false, NOW),
    ).toEqual([])

    const failed = [sent('never pasted', 0, { state: 'failed', error: 'gone' })]
    expect(settle(failed, [ask('never pasted')], 0, false, NOW)).toHaveLength(1)
  })

  it('merges host outbox with local optimistic bubbles and deduplicates client_op', () => {
    const host: Array<SentRecord> = [
      {
        id: 'sent-1',
        client_op: 'op-1',
        kind: 'message',
        text: 'hello',
        attachments: ['img-a.jpg'],
        created_at: NOW - 2_000,
        status: 'unconfirmed',
        transcript_end_at_send: 3,
      },
    ]
    const local: Array<Pending> = [
      sent('hello', 3, { clientOp: 'op-1', state: 'queued', at: NOW - 2_100 }),
      sent('still sending', 3, {
        clientOp: 'op-2',
        state: 'sending',
        at: NOW - 500,
      }),
    ]
    const merged = mergeOutboxPending(local, host)
    expect(merged).toHaveLength(2)
    expect(merged[0]).toMatchObject({
      sentId: 'sent-1',
      state: 'lost',
      attachments: ['img-a.jpg'],
    })
    expect(merged[1]).toMatchObject({
      clientOp: 'op-2',
      state: 'sending',
    })
  })
})
