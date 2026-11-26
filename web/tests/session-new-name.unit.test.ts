import { describe, expect, it } from 'vitest'

import { suggestGroupName } from '#/features/session-new'

describe('suggestGroupName', () => {
  it('extracts a task phrase from the first line', () => {
    expect(suggestGroupName('帮我修复网页会话列表。\n详细说明')).toBe(
      '修复网页会话列表',
    )
    expect(
      suggestGroupName('Please fix keyboard navigation. More details.'),
    ).toBe('fix keyboard navigation')
  })

  it('falls back for short acknowledgements and pasted links', () => {
    expect(suggestGroupName('继续')).toBe('')
    expect(suggestGroupName('https://example.com')).toBe('')
  })

  it('truncates on character boundaries', () => {
    expect(suggestGroupName('🧪'.repeat(40))).toBe('🧪'.repeat(31) + '…')
  })
})
