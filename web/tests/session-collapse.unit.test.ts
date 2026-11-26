import { describe, expect, it, vi } from 'vitest'

import { parseCollapsed, setChatCollapsed } from '#/features/session-collapse'

describe('parseCollapsed', () => {
  it('reads only true flags, tolerates missing / bad / wrong-shaped input', () => {
    expect(parseCollapsed(null)).toEqual({})
    expect(parseCollapsed('')).toEqual({})
    expect(parseCollapsed('not json')).toEqual({})
    expect(parseCollapsed('[1,2]')).toEqual({})
    expect(parseCollapsed('"x"')).toEqual({})
    expect(parseCollapsed('{"a":true,"b":false,"c":1,"d":"true"}')).toEqual({
      a: true,
    })
  })
})

describe('setChatCollapsed', () => {
  it('merges flags, removes on expand, persists best-effort', () => {
    const data = new Map<string, string>()
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
    }
    vi.stubGlobal('localStorage', storage)

    setChatCollapsed('/r/a', true)
    setChatCollapsed('/r/b', true)
    setChatCollapsed('/r/a', false)
    const saved = data.get('wezdeck-chat-collapse-v1')
    expect(parseCollapsed(saved ?? null)).toEqual({ '/r/b': true })

    // a blocked store must not throw the toggle
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    })
    expect(() => setChatCollapsed('/r/c', true)).not.toThrow()
    vi.unstubAllGlobals()
  })
})
