import { describe, expect, it } from 'vitest'

import { compactScreen, metaValue } from '#/features/session-empty'
import type { Detail } from '#/features/console-sessions'

describe('compactScreen (an empty session’s terminal screen)', () => {
  it('drops blank margins and folds blank runs to one row', () => {
    const screen = [
      'master ~/repo      1.3k / 500k   ',
      '',
      '   Session 01a2, use /dashboard   ',
      '',
      '',
      '',
      '  ╭──╮  ',
      '  │ ❯│  ',
      '  ╰──╯  ',
      '',
      '  Shift+Tab:mode',
      '',
      '',
    ].join('\n')
    expect(compactScreen(screen)).toBe(
      [
        'master ~/repo      1.3k / 500k',
        '',
        '   Session 01a2, use /dashboard',
        '',
        '  ╭──╮',
        '  │ ❯│',
        '  ╰──╯',
        '',
        '  Shift+Tab:mode',
      ].join('\n'),
    )
  })
  it('a blank screen is empty', () => {
    expect(compactScreen('\n   \n\n')).toBe('')
  })
})

describe('metaValue (the empty state reads structured data)', () => {
  it('finds a row in a meta group, else empty', () => {
    const data = {
      id: 's1',
      meta: [
        {
          name: 'session',
          rows: [
            { key: 'model', value: 'grok-4.5' },
            { key: 'effort', value: 'xhigh' },
          ],
        },
        { name: 'location', rows: [{ key: 'cwd', value: '/r/a' }] },
      ],
    } as unknown as Detail
    expect(metaValue(data, 'session', 'effort')).toBe('xhigh')
    expect(metaValue(data, 'location', 'cwd')).toBe('/r/a')
    expect(metaValue(data, 'location', 'branch')).toBe('')
    expect(metaValue(data, 'nope', 'x')).toBe('')
  })
})
