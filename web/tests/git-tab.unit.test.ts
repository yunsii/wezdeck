import { describe, expect, it } from 'vitest'

import { defaultGitTab } from '#/features/git-tab'
import type { GitDetail } from '#/features/session-git'

const base: GitDetail = {
  status: {
    staged: 0,
    unstaged: 0,
    untracked: 0,
    upstream: true,
    ahead: 0,
    behind: 0,
  },
  files: [],
  ahead: [],
  behind: [],
  recent: [],
}

describe('defaultGitTab', () => {
  it('opens on the changes when there are any, else the commits', () => {
    expect(defaultGitTab(base)).toBe('commits')
    expect(
      defaultGitTab({
        ...base,
        files: [{ path: 'a.ts', state: 'untracked', code: '?' }],
      }),
    ).toBe('changes')
    // ahead but clean: the commits explain the tag
    expect(
      defaultGitTab({
        ...base,
        status: { ...base.status, ahead: 2 },
        ahead: [{ sha: 'abc', subject: 's', author: 'a', at: 0 }],
      }),
    ).toBe('commits')
  })
})
