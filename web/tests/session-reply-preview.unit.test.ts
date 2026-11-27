import { describe, expect, it } from 'vitest'

import { cachedAgentReply } from '#/features/session-reply-preview'

const row = { id: 'reply', status: 'done', ts: 200 }

describe('Markdown session reply preview', () => {
  const preview = (text: string) =>
    cachedAgentReply(row, {
      ...row,
      messages: [
        { role: 'user', text: 'ship it' },
        { role: 'assistant', text },
      ],
    })

  it('keeps readable text without heading, emphasis, link, or list syntax', () => {
    expect(
      preview(
        '## 已完成\n\n**修复**了 [会话列表](https://example.com)；`npm test` 通过。\n\n- 第一项\n- 第二项',
      ),
    ).toBe('已完成 修复了 会话列表；npm test 通过。 第一项 第二项')
  })

  it('flattens a table into one line', () => {
    expect(preview('| 状态 | 结果 |\n| --- | --- |\n| 测试 | 通过 |')).toBe(
      '状态 结果 测试 通过',
    )
  })
})
