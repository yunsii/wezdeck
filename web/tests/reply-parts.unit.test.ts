import { describe, expect, it } from 'vitest'

import { ReplyParts } from '../src/lib/reply-parts'

describe('reply parts', () => {
  const body = JSON.stringify({
    t: 'res',
    id: 'r1',
    ok: true,
    result: { text: '会话'.repeat(500) },
  })
  const slices = [body.slice(0, 300), body.slice(300, 700), body.slice(700)]
  const frame = (seq: number) => ({
    t: 'part',
    id: 'r1',
    seq,
    total: 3,
    data: slices[seq],
  })

  it('joins only once every slice is in, in any order', () => {
    const parts = new ReplyParts()
    expect(parts.add(frame(2))).toBeNull()
    expect(parts.add(frame(0))).toBeNull()
    expect(parts.add(frame(1))).toBe(body)
  })
  it('a dropped request forgets its slices; bad frames are ignored', () => {
    const parts = new ReplyParts()
    expect(parts.add(frame(0))).toBeNull()
    parts.drop('r1')
    expect(parts.add(frame(1))).toBeNull()
    expect(
      parts.add({ t: 'part', id: 'r2', seq: 5, total: 2, data: 'x' }),
    ).toBeNull()
    expect(
      parts.add({ t: 'part', id: '', seq: 0, total: 1, data: 'x' }),
    ).toBeNull()
  })
})
