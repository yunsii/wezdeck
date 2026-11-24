import { describe, expect, it } from 'vitest'

import { splitTokens, typedText } from '#/features/chat-attachments'

describe('sent attachments', () => {
  it('cuts [图片N] out as chips for the images that were sent', () => {
    expect(
      splitTokens('把 [图片1] 改成 [图片2] 那样，[图片3] 不存在', [
        '图片1',
        '图片2',
      ]),
    ).toEqual([
      '把 ',
      { label: '图片1', index: 0 },
      ' 改成 ',
      { label: '图片2', index: 1 },
      ' 那样，',
      '[图片3]',
      ' 不存在',
    ])
    expect(splitTokens('没有图片', [])).toEqual(['没有图片'])
  })

  it('drops the host note from the typed text', () => {
    expect(typedText('看 [图片1]\n\n[手机附件]\n- 图片1: /x/img-1-a.jpg')).toBe(
      '看 [图片1]',
    )
  })
})
