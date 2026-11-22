import { describe, expect, it } from 'vitest'

import { group, settleCursor } from '#/features/chat-thread'
import type { Message } from '#/features/chat-thread'

const say = (text: string): Message => ({ role: 'assistant', text })
const ask = (text: string): Message => ({ role: 'user', text })
const tool = (text: string): Message => ({ role: 'tool', text, tool: 'Bash' })

describe('settleCursor (new-message reveal never stalls)', () => {
  it('moves a cursor stranded inside a grown run of tool calls to its end', () => {
    // revealed up to the end of a 2-call run (cursor 3); the run then grew to 4
    const messages = [
      ask('go'),
      tool('a'),
      tool('b'),
      tool('c'),
      tool('d'),
      say('done'),
    ]
    expect(settleCursor(group(messages), 0, 3)).toBe(5)
  })

  it('leaves cursors on item boundaries alone', () => {
    const messages = [ask('go'), tool('a'), tool('b'), say('done')]
    const items = group(messages)
    for (const at of [0, 1, 3, 4]) expect(settleCursor(items, 0, at)).toBe(at)
  })

  it('works with absolute indices of a paginated window', () => {
    // window starts at 100: tools occupy 101..104, cursor stranded at 102
    const messages = [
      ask('go'),
      tool('a'),
      tool('b'),
      tool('c'),
      tool('d'),
      say('x'),
    ]
    expect(settleCursor(group(messages), 100, 102)).toBe(105)
  })
})
