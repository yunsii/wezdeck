import { describe, expect, it } from 'vitest'

import { turnState, revealingTurnState } from '#/features/chat-turn'
import type { Message } from '#/features/chat-thread'
import { formatTokenRate, formatTtft } from '#/lib/turn-progress'

const at = (s: number) =>
  new Date(Date.UTC(2026, 10, 24, 5, 0, s)).toISOString()
const t0 = Date.parse(at(0))
const user = (s: number): Message => ({ role: 'user', text: 'q', ts: at(s) })
const reply = (s: number): Message => ({
  role: 'assistant',
  text: 'a',
  ts: at(s),
})

describe('turn line', () => {
  it('works while the host says running', () => {
    expect(
      turnState({
        messages: [user(0)],
        left: [],
        busy: true,
        activity: { since: t0 },
      }),
    ).toEqual({ kind: 'working', activity: { since: t0 } })
  })

  it('uses a short pending fallback only before host state is known', () => {
    expect(
      turnState({
        messages: [user(0), reply(30)],
        left: [{ text: 'next', at: t0 + 60_000 }],
        busy: false,
        now: t0 + 61_000,
      }),
    ).toEqual({ kind: 'working', activity: { since: t0 + 60_000 } })
    expect(
      turnState({
        messages: [user(0), reply(30)],
        left: [{ text: 'next', at: t0 + 60_000 }],
        busy: false,
        status: 'idle',
        now: t0 + 61_000,
      }),
    ).toEqual({ kind: 'done', took: 30_000, at: t0 + 30_000 })
    expect(
      turnState({
        messages: [user(0), reply(30)],
        left: [{ text: 'next', at: t0 + 60_000 }],
        busy: false,
        now: t0 + 80_000,
      }),
    ).toEqual({ kind: 'done', took: 30_000, at: t0 + 30_000 })
  })

  it('never shows working for lost or failed outbox bubbles', () => {
    expect(
      turnState({
        messages: [],
        left: [
          { text: 'dropped', at: t0, state: 'lost' },
          { text: 'errored', at: t0 + 10_000, state: 'failed' },
        ],
        busy: false,
        status: 'idle',
      }),
    ).toBeNull()
    expect(
      turnState({
        messages: [],
        left: [
          { text: 'dropped', at: t0, state: 'lost' },
          { text: 'fresh retry', at: t0 + 60_000, state: 'queued' },
        ],
        busy: false,
        status: 'idle',
      }),
    ).toBeNull()
  })

  it('does not time a deferred message as an agent turn', () => {
    expect(
      turnState({
        messages: [user(0), reply(30)],
        left: [
          { text: 'after review', at: t0 + 60_000, state: 'deferred' },
          {
            text: 'waiting for review',
            at: t0 + 70_000,
            state: 'waiting_review',
          },
        ],
        busy: false,
        status: 'idle',
      }),
    ).toEqual({ kind: 'done', took: 30_000, at: t0 + 30_000 })
    expect(
      turnState({
        messages: [user(0), reply(30)],
        left: [
          { text: 'after review', at: t0 + 60_000, state: 'deferred' },
          { text: 'sent now', at: t0 + 80_000, state: 'queued' },
        ],
        busy: false,
        status: 'idle',
      }),
    ).toEqual({ kind: 'done', took: 30_000, at: t0 + 30_000 })
  })

  it('keeps working while the prompt is in the transcript but not running yet', () => {
    expect(
      turnState({
        messages: [reply(0), user(10)],
        left: [],
        busy: false,
        status: 'done',
        statusTs: t0,
        now: t0 + 12_000,
      }),
    ).toEqual({ kind: 'working', activity: { since: t0 + 10_000 } })
    // an old unanswered prompt is not "working" forever
    expect(
      turnState({
        messages: [user(10)],
        left: [],
        busy: false,
        status: 'idle',
        now: t0 + 10 * 60_000,
      }),
    ).toBeNull()
  })

  it('then says how long the turn took and when it ended', () => {
    expect(
      turnState({
        messages: [user(0), reply(20), { role: 'tool', text: 't' }, reply(36)],
        left: [],
        busy: false,
        status: 'done',
      }),
    ).toEqual({ kind: 'done', took: 36_000, at: t0 + 36_000 })
    // no times in the transcript (Grok): the entry's last change
    expect(
      turnState({
        messages: [
          { role: 'user', text: 'q' },
          { role: 'assistant', text: 'a' },
        ],
        left: [],
        busy: false,
        status: 'done',
        statusTs: t0,
      }),
    ).toEqual({ kind: 'done', took: undefined, at: t0 })
  })

  it('says nothing while a question waits on you', () => {
    expect(
      turnState({
        messages: [user(0)],
        left: [],
        busy: false,
        status: 'waiting',
      }),
    ).toBeNull()
  })
})

describe('revealingTurnState (the turn line never leaves mid-reveal)', () => {
  it('a done turn reads working until its last reply is revealed', () => {
    const done = { kind: 'done' as const, took: 1000, at: 5 }
    expect(revealingTurnState(done, true)).toEqual({ kind: 'working' })
    expect(revealingTurnState(done, false)).toBe(done)
  })
  it('working and nothing pass through', () => {
    const working = {
      kind: 'working' as const,
      activity: { since: 1, rate: 88.6 },
    }
    expect(revealingTurnState(working, true)).toBe(working)
    expect(revealingTurnState(null, true)).toBeNull()
  })
})

describe('token rate formatting', () => {
  it('formats effective tok/s and TTFT cleanly', () => {
    expect(formatTokenRate(0)).toBe('')
    expect(formatTokenRate(56.1)).toBe('56.1 tok/s')
    expect(formatTokenRate(80.0)).toBe('80 tok/s')
    expect(formatTokenRate(120.4)).toBe('120 tok/s')
    expect(formatTtft(0)).toBe('')
    expect(formatTtft(420)).toBe('420ms')
    expect(formatTtft(2637)).toBe('2.6s')
  })
})
