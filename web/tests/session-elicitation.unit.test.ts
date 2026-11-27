import { describe, expect, it } from 'vitest'

import { pickElicitationOption } from '#/features/session-elicitation'

const sender =
  (keys: Array<string>, failOn = '') =>
  async (key: string) => {
    keys.push(key)
    return key === failOn ? false : true
  }

describe('pickElicitationOption (Grok Ask)', () => {
  it('supports direct options beyond the old four-key allowlist', async () => {
    const keys: Array<string> = []
    await expect(pickElicitationOption(5, sender(keys))).resolves.toBe(true)
    expect(keys).toEqual(['6', 'Enter'])
  })

  it('stops the sequence when a write fails instead of submitting a default', async () => {
    const keys: Array<string> = []
    await expect(pickElicitationOption(5, sender(keys, '6'))).resolves.toBe(
      false,
    )
    expect(keys).toEqual(['6'])
  })

  it('only toggles a multi-select option; Enter is a separate action', async () => {
    const keys: Array<string> = []
    await expect(pickElicitationOption(1, sender(keys), true)).resolves.toBe(
      true,
    )
    expect(keys).toEqual(['2'])
  })

  it('uses Space to toggle an option beyond the digit shortcuts', async () => {
    const keys: Array<string> = []
    await expect(pickElicitationOption(9, sender(keys), true)).resolves.toBe(
      true,
    )
    expect(keys).toEqual([
      ...Array(12).fill('Up'),
      ...Array(9).fill('Down'),
      'Space',
    ])
  })

  it('Agy single-select sends only the digit without trailing Enter so question 2 is never skipped', async () => {
    const keys: Array<string> = []
    await expect(
      pickElicitationOption(0, sender(keys), false, true),
    ).resolves.toBe(true)
    expect(keys).toEqual(['1'])
  })

  it('Agy options beyond 9 still navigate with arrows and Enter', async () => {
    const keys: Array<string> = []
    await expect(
      pickElicitationOption(9, sender(keys), false, true),
    ).resolves.toBe(true)
    expect(keys).toEqual([
      ...Array(12).fill('Up'),
      ...Array(9).fill('Down'),
      'Enter',
    ])
  })
})
