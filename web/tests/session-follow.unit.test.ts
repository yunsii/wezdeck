// covers: web/src/features/session-follow.ts
import { describe, expect, it } from 'vitest'

import { sessionIdFromPath } from '#/features/session-follow'

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
