import { describe, expect, it } from 'vitest'

import { formatElapsed, formatTokens } from '#/lib/turn-progress'

describe('turn progress formatting', () => {
  it('elapsed like the desk TUI', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(36_400)).toBe('36s')
    expect(formatElapsed(279_000)).toBe('4m 39s')
    expect(formatElapsed(3_723_000)).toBe('1h 02m')
    expect(formatElapsed(249_000)).toBe('4m 09s')
    expect(formatElapsed(-500)).toBe('0s') // clock skew between host and phone
  })

  it('tokens', () => {
    expect(formatTokens(812)).toBe('812')
    expect(formatTokens(19_120)).toBe('19.1k')
    expect(formatTokens(2000)).toBe('2k')
    expect(formatTokens(1_230_000)).toBe('1.2M')
  })
})
