import { describe, expect, it } from 'vitest'

import { foregroundCall } from '#/features/chat-thread'
import type { Message } from '#/features/chat-thread'

const call = (tool: string, extra: Partial<Message> = {}): Message => ({
  role: 'tool',
  text: tool,
  tool,
  pending: true,
  ...extra,
})

describe('foregroundCall (when 转到后台 is offered)', () => {
  it('a foreground Bash or subagent still running', () => {
    expect(foregroundCall([call('Bash')])).toBe(true)
    expect(foregroundCall([call('Agent')])).toBe(true)
    expect(foregroundCall([call('Task')])).toBe(true)
  })

  it('not once it returned, ran in the background already, or is another tool', () => {
    expect(foregroundCall([call('Bash', { pending: false })])).toBe(false)
    expect(foregroundCall([call('Bash', { background: true })])).toBe(false)
    expect(foregroundCall([call('Read')])).toBe(false)
    expect(foregroundCall([call('Edit')])).toBe(false)
  })

  it('only the newest message counts', () => {
    expect(
      foregroundCall([call('Bash'), { role: 'assistant', text: 'done' }]),
    ).toBe(false)
    expect(foregroundCall([])).toBe(false)
  })
})
