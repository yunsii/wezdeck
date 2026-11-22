import { describe, expect, it } from 'vitest'

import { withDeskRetry } from '#/features/session-send'

const noSleep = () => Promise.resolve()

describe('withDeskRetry (phone waits out input at the desk)', () => {
  it('counts down the seconds the host asks for, then resends', async () => {
    let calls = 0
    const waits: Array<number> = []
    const result = await withDeskRetry(
      () => {
        calls++
        if (calls === 1)
          return Promise.reject(
            new Error('someone typed at the desk 7s ago; retry in 3s'),
          )
        return Promise.resolve('sent')
      },
      (s) => waits.push(s),
      3,
      noSleep,
    )
    expect(result).toBe('sent')
    expect(calls).toBe(2)
    expect(waits).toEqual([3, 2, 1, 0])
  })

  it('does not retry other errors', async () => {
    let calls = 0
    await expect(
      withDeskRetry(
        () => {
          calls++
          return Promise.reject(new Error('device not approved'))
        },
        () => {},
        3,
        noSleep,
      ),
    ).rejects.toThrow('device not approved')
    expect(calls).toBe(1)
  })

  it('gives up after the allowed rounds', async () => {
    let calls = 0
    await expect(
      withDeskRetry(
        () => {
          calls++
          return Promise.reject(new Error('retry in 1s'))
        },
        () => {},
        2,
        noSleep,
      ),
    ).rejects.toThrow('retry in 1s')
    expect(calls).toBe(3)
  })
})
