import { describe, expect, it } from 'vitest'

import { toEntry } from '../src/features/console-diagnostics'

const line = (ts: string, message: string) =>
  ({
    ts,
    level: 'info',
    category: 'attention',
    trace_id: 't1',
    message,
    raw: `ts="${ts}"`,
  }) as never

describe('diagnostics entries', () => {
  it('an entry keeps its id when newer lines land above it', () => {
    const before = [line('14:32:41', 'b'), line('14:32:40', 'a')].map(toEntry)
    const after = [
      line('14:32:45', 'c'),
      line('14:32:41', 'b'),
      line('14:32:40', 'a'),
    ].map(toEntry)
    expect(after[1].id).toBe(before[0].id)
    expect(new Set(after.map((e) => e.id)).size).toBe(3)
  })
  it('reads the fields the Runtime sends, upper-case keys too', () => {
    const e = toEntry({
      Ts: '1',
      Level: 'warn',
      Category: 'c',
      TraceId: 'x',
      Message: 'm',
    })
    expect([e.level, e.category, e.trace, e.message]).toEqual([
      'warn',
      'c',
      'x',
      'm',
    ])
  })
})
