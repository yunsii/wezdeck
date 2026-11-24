import { beforeEach, describe, expect, it } from 'vitest'

import { pickLast, rememberOpened } from '#/lib/last-opened'

// a Map-backed localStorage (the unit tests run in Node)
beforeEach(() => {
  const data = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
    key: () => null,
    length: 0,
  }
})

describe('pickLast (which item a split opens with no id in the URL)', () => {
  const all = ['a', 'b', 'c', 'd']
  it('the item last opened under this filter, when still listed there', () => {
    rememberOpened('s', 'b', 'running')
    rememberOpened('s', 'd', 'idle') // opened later, elsewhere
    expect(pickLast('s', 'running', ['a', 'b'], all)).toEqual({ id: 'b' })
  })
  it('else the last one overall if this filter lists it', () => {
    rememberOpened('s', 'c', 'idle')
    expect(pickLast('s', 'running', ['a', 'c'], all)).toEqual({ id: 'c' })
  })
  it('else the last one overall from 全部, if it still exists', () => {
    rememberOpened('s', 'b', 'running')
    rememberOpened('s', 'd', 'idle')
    // running lists only a now: b left it, d was never in it
    expect(pickLast('s', 'running', ['a'], all)).toEqual({ id: 'd', all: true })
  })
  it('nothing when the remembered items are gone (caller opens its first)', () => {
    rememberOpened('s', 'x', 'running')
    expect(pickLast('s', 'running', ['a'], all)).toEqual({})
    expect(pickLast('fresh', 'all', all, all)).toEqual({})
  })
})
