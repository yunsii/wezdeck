import { describe, expect, it } from 'vitest'

import {
  openQuestion,
  parseThread,
  threadClipped,
} from '../src/lib/ticket-thread'

const thread = `
- (2026-11-13T07:56:03Z) initiator: PR1 收尾：
1) 状态码改成 499
2) 不要提交。

- (2026-11-13T07:37:49Z) worker challenge: 确认一下 499 还是 0？
- (2026-11-13T07:00:00Z) note without a role
`

describe('ticket thread', () => {
  it('parses entries oldest first, with continuation lines', () => {
    const entries = parseThread(thread)
    expect(entries.map((e) => e.who)).toEqual([
      '',
      'worker challenge',
      'initiator',
    ])
    expect(entries[2].text).toBe('PR1 收尾：\n1) 状态码改成 499\n2) 不要提交。')
    expect(entries[1].at).toBe('2026-11-13T07:37:49Z')
    expect(entries[0].text).toBe('note without a role')
  })
  it('the open question is the newest entry, not the oldest', () => {
    expect(
      openQuestion([
        {
          title: 'Thread',
          text: '- (2) worker challenge: 新问题\n- (1) worker challenge: 旧问题',
        },
      ]),
    ).toBe('新问题')
    expect(openQuestion([{ title: 'Summary', text: 'x' }])).toBe('')
  })
  it('knows when the API cut the oldest entries off', () => {
    expect(threadClipped('x'.repeat(7999) + '…')).toBe(true)
    expect(threadClipped('short…')).toBe(false)
  })
})
