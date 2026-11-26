import { describe, expect, it } from 'vitest'
import { sessionSyncChanged } from '../src/lib/session-sync-trace'

describe('session sync trace', () => {
  it('records first load, a new message, status change or replacement', () => {
    const current = { total: 3, status: 'running' }
    expect(sessionSyncChanged(undefined, current)).toBe(true)
    expect(sessionSyncChanged(current, { ...current })).toBe(false)
    expect(sessionSyncChanged(current, { ...current, total: 4 })).toBe(true)
    expect(sessionSyncChanged(current, { ...current, status: 'done' })).toBe(
      true,
    )
    expect(
      sessionSyncChanged(current, { ...current, replaced_by: 'next' }),
    ).toBe(true)
  })
})
