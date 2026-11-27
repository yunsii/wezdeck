import { describe, expect, it } from 'vitest'

import {
  alwaysAllowScope,
  sendPermissionKeys,
} from '#/features/session-permission'

describe('session-permission helpers', () => {
  it('extracts rule scope from Agy Always allow labels', () => {
    expect(
      alwaysAllowScope(
        'Yes, and always allow for commands that start with "scripts/dev/wezdeck-release.sh"',
      ),
    ).toBe('for commands that start with "scripts/dev/wezdeck-release.sh"')
    expect(alwaysAllowScope("Yes, and always allow 'git push'")).toBe(
      "'git push'",
    )
    expect(alwaysAllowScope('Always allow read_file')).toBe('read_file')
  })

  it('sends key sequences in order and stops if a step fails', async () => {
    const sent: Array<string> = []
    const ok = await sendPermissionKeys(
      ['Down', 'Enter'],
      async (key) => {
        sent.push(key)
        return true
      },
      0,
    )
    expect(ok).toBe(true)
    expect(sent).toEqual(['Down', 'Enter'])

    const aborted: Array<string> = []
    const failed = await sendPermissionKeys(
      ['Down', 'Enter'],
      async (key) => {
        aborted.push(key)
        return false
      },
      0,
    )
    expect(failed).toBe(false)
    expect(aborted).toEqual(['Down'])
  })
})
