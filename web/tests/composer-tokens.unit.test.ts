import { describe, expect, it } from 'vitest'

import { dropToken, insertTokens, tokenAt } from '#/features/composer-tokens'

describe('composer image tokens', () => {
  it('inserts at the caret with spaces only where needed', () => {
    expect(insertTokens('看这里的按钮', 3, ['[图片1]'])).toEqual({
      text: '看这里 [图片1] 的按钮',
      caret: 10,
    })
    expect(insertTokens('', 0, ['[图片1]', '[图片2]']).text).toBe(
      '[图片1] [图片2] ',
    )
    expect(insertTokens('结尾 ', 3, ['[图片1]']).text).toBe('结尾 [图片1] ')
    // a caret past the end (stale selection) clamps to the end
    expect(insertTokens('ab', 99, ['[图片1]']).text).toBe('ab [图片1] ')
  })

  it('drops a token and renumbers the later ones', () => {
    expect(dropToken('把 [图片1] 改成 [图片2] 和 [图片3]', 2)).toBe(
      '把 [图片1] 改成 和 [图片2]',
    )
    expect(dropToken('[图片1] 开头', 1)).toBe('开头')
    expect(dropToken('结尾 [图片1]', 1)).toBe('结尾')
    // inserted at the end (with its trailing space), then removed: no residue
    expect(dropToken(insertTokens('第二行', 3, ['[图片1]']).text, 1)).toBe(
      '第二行',
    )
    // the user deleted the token by hand: only the renumbering happens
    expect(dropToken('只有 [图片2]', 1)).toBe('只有 [图片1]')
  })

  it('finds the token the caret touches, as one unit', () => {
    const text = '把 [图片1] 改成 [图片12]'
    expect(tokenAt(text, 7, 'before')).toEqual([2, 7]) // caret after [图片1]
    expect(tokenAt(text, 2, 'after')).toEqual([2, 7]) // caret before it
    expect(tokenAt(text, 4, 'before')).toEqual([2, 7]) // inside it
    expect(tokenAt(text, 17, 'before')).toEqual([11, 17])
    expect(tokenAt(text, 8, 'before')).toBeNull() // after the space
    expect(tokenAt(text, 1, 'after')).toBeNull()
  })
})
