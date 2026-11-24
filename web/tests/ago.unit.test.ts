import { describe, expect, it } from 'vitest'

import { formatAgo } from '#/features/tickets-view'

// Layout stability: within a minute the text must not change from one
// render to the next (polls re-render every 1–2.5 s)
describe('formatAgo', () => {
  const at = '2026-11-24T12:00:00.000Z'
  const t0 = Date.parse(at)
  it('reads the same for the whole first minute', () => {
    for (const locale of ['zh', 'en']) {
      const first = formatAgo(at, t0, locale)
      for (let s = 0; s < 60; s += 1)
        expect(formatAgo(at, t0 + s * 1000, locale)).toBe(first)
    }
    expect(formatAgo(at, t0 + 5_000, 'zh')).toBe('现在')
  })
  it('then counts minutes, hours, days', () => {
    expect(formatAgo(at, t0 + 61_000, 'en')).toMatch(/1 min/)
    expect(formatAgo(at, t0 + 2 * 3_600_000, 'zh')).toMatch(/2.*小时/)
    expect(formatAgo(at, t0 + 3 * 86_400_000, 'en')).toMatch(/3 days?/)
    expect(formatAgo(undefined, t0, 'en')).toBe('')
  })
})
