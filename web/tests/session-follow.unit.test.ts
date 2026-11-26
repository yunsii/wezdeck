// covers: web/src/features/session-follow.ts
import { afterEach, describe, expect, it } from 'vitest'

import {
  canFollowSession,
  resetSessionFollowState,
  sessionIdFromPath,
} from '#/features/session-follow'

describe('session follow path', () => {
  it('reads the session id only on a detail URL', () => {
    expect(
      sessionIdFromPath(
        '/zh/console/sessions/01a2160d-bc12-74a3-98df-29461c621823',
      ),
    ).toBe('01a2160d-bc12-74a3-98df-29461c621823')
    expect(sessionIdFromPath('/console/sessions/demo-next')).toBe('demo-next')
    expect(sessionIdFromPath('/zh/console/sessions')).toBeUndefined()
    expect(sessionIdFromPath('/zh/console/collab/t1')).toBeUndefined()
  })
})

describe('canFollowSession', () => {
  afterEach(() => resetSessionFollowState())

  it('allows a first handoff', () => {
    expect(canFollowSession('old', 'new', new Set())).toBe(true)
  })

  it('refuses a hop onto a session already left via follow (A↔B)', () => {
    const left = new Set(['a'])
    expect(canFollowSession('a', 'b', left)).toBe(true)
    left.add('a')
    expect(canFollowSession('b', 'a', left)).toBe(false)
  })

  it('refuses a longer cycle back to an earlier from', () => {
    const left = new Set(['a', 'b'])
    expect(canFollowSession('c', 'a', left)).toBe(false)
    expect(canFollowSession('c', 'd', left)).toBe(true)
  })

  it('refuses empty or identical ids', () => {
    expect(canFollowSession('', 'b', new Set())).toBe(false)
    expect(canFollowSession('a', 'a', new Set())).toBe(false)
  })
})
