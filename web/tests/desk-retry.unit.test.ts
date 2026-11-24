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

describe('slash commands', () => {
  it('a command is recognised, a path is a message', async () => {
    const { commandOf } = await import('#/features/session-send')
    expect(commandOf('/new')).toBe('/new')
    expect(commandOf('  /compact keep the plan ')).toBe('/compact')
    expect(commandOf('/plugin:run x')).toBe('/plugin:run')
    expect(commandOf('/home/yuns/shot.png 看下这张')).toBe('')
    expect(commandOf('请执行 /new')).toBe('')
    expect(commandOf('/')).toBe('')
  })
})

describe('namedClear', () => {
  it('finds the name Claude would give the new session', async () => {
    const { namedClear } = await import('#/features/session-commands')
    expect(namedClear('/new')).toBe('')
    expect(namedClear(' /clear ')).toBe('')
    expect(namedClear('/new 都支持了，那 /resume 呢')).toBe(
      '都支持了，那 /resume 呢',
    )
    expect(namedClear('/CLEAR web titles')).toBe('web titles')
    expect(namedClear('/newer x')).toBe('')
    expect(namedClear('既然 /new 都支持了')).toBe('')
    expect(namedClear('/compact keep it')).toBe('')
  })
})
