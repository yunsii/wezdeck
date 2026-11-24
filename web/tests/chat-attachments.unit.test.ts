import { describe, expect, it } from 'vitest'

import {
  endsWithNote,
  splitTokens,
  typedText,
  withAttachmentNote,
} from '#/features/chat-attachments'

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

  it('reads the note under its new name and the old one', () => {
    expect(typedText('看 [图片1]\n\n[网页附件]\n- 图片1: /x/img-1-a.jpg')).toBe(
      '看 [图片1]',
    )
    expect(endsWithNote('看\n\n[网页附件]\n- 图片1: /x/a.jpg', '看')).toBe(true)
    expect(endsWithNote('[手机附件]\n- 图片: /x/a.jpg', '')).toBe(true)
    expect(endsWithNote('看别的\n\n[网页附件]\n- 图片1: /x/a.jpg', '看')).toBe(
      false,
    )
  })

  it('drops the host note from the typed text', () => {
    expect(typedText('看 [图片1]\n\n[手机附件]\n- 图片1: /x/img-1-a.jpg')).toBe(
      '看 [图片1]',
    )
  })
})

describe('withAttachmentNote (the queued bubble shows what the message becomes)', () => {
  it('numbers images and labels diagnostics like the relay does', () => {
    expect(
      withAttachmentNote('看这里', [
        'img-1-a.jpg',
        'diagnostics-2-b.json',
        'img-3-c.png',
      ]),
    ).toBe(
      '看这里\n\n[网页附件]\n- 图片1: img-1-a.jpg\n- 客户端诊断: diagnostics-2-b.json\n- 图片2: img-3-c.png',
    )
  })
  it('only a note when nothing was typed; the text alone when nothing is attached', () => {
    expect(withAttachmentNote('  ', ['img-1-a.jpg'])).toBe(
      '[网页附件]\n- 图片1: img-1-a.jpg',
    )
    expect(withAttachmentNote('hi', [])).toBe('hi')
    expect(withAttachmentNote('hi')).toBe('hi')
  })
  it('reads back as typed text plus an image, the way a sent message does', () => {
    const text = withAttachmentNote('看这里', ['img-1-a.jpg'])
    expect(endsWithNote(text, '看这里')).toBe(true)
    expect(typedText(text)).toBe('看这里')
  })
})
