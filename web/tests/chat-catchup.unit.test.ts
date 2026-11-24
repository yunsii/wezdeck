import { describe, expect, it } from 'vitest'

import { BACKLOG, catchUp } from '#/features/chat-catchup'
import { group } from '#/features/chat-thread'
import type { Message } from '#/features/chat-thread'

const say = (text: string): Message => ({ role: 'assistant', text })
const ask = (text: string): Message => ({ role: 'user', text })
const tool = (text: string): Message => ({ role: 'tool', text, tool: 'Bash' })

describe('catchUp (a backlog shows at once, the newest reply unfolds)', () => {
  it('replays one by one while few replies wait', () => {
    const items = group([ask('q'), say('a'), tool('ls'), say('b')])
    // cursor at 1: two replies waiting — the normal reading-pace replay
    expect(BACKLOG).toBe(2)
    expect(catchUp(items, 0, 1)).toBe(1)
  })

  it('moves onto the newest reply once more than BACKLOG wait', () => {
    const items = group([
      ask('q'),
      say('a'),
      tool('ls'),
      tool('cat'),
      say('b'),
      say('c'),
      tool('rg'),
    ])
    // replies at 1, 4, 5 → cursor onto 5; the tool run after it follows
    expect(catchUp(items, 0, 1)).toBe(5)
  })

  it('counts replies, not tool runs or user lines', () => {
    const items = group([say('a'), tool('x'), ask('y'), tool('z'), say('b')])
    expect(catchUp(items, 0, 0)).toBe(0)
  })

  it('uses absolute indices when earlier pages are not loaded', () => {
    const items = group([say('a'), say('b'), say('c')])
    expect(catchUp(items, 100, 100)).toBe(102)
    // already past them: nothing to catch up
    expect(catchUp(items, 100, 103)).toBe(103)
  })
})
