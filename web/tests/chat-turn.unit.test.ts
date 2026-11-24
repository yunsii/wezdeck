import { describe, expect, it } from 'vitest'

import { turnState } from '#/features/chat-turn'
import type { Message } from '#/features/chat-thread'

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

  it('works at once after a send, timed from the send (optimistic)', () => {
    expect(
      turnState({
        messages: [user(0), reply(30)],
        left: [{ text: 'next', at: t0 + 60_000 }],
        busy: false,
        status: 'done',
      }),
    ).toEqual({ kind: 'working', activity: { since: t0 + 60_000 } })
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
