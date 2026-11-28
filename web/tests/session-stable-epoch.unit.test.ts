import { describe, expect, it } from 'vitest'

import { buildChatGroups } from '#/features/session-chats'
import { stableGroupsForEpoch } from '#/features/session-stable'
import type { SessionCard } from '#/features/console-sessions'

const card = (repo: string, activity: number): SessionCard => ({
  id: `${repo}-${activity}`,
  agent: 'codex',
  name: 'codex',
  window: repo,
  cwd: `/r/${repo}`,
  branch: 'main',
  status: 'idle',
  last_prompt: '',
  ts: activity,
  order_at: activity,
  transcript: true,
  desk_idle_s: 0,
  repo,
  repo_root: `/r/${repo}`,
  worktree: `/r/${repo}`,
})

describe('session list host epoch', () => {
  it('holds order within one host process and resets it after WSL restarts', () => {
    const old = buildChatGroups([card('a', 200), card('b', 100)])
    const fresh = buildChatGroups([card('a', 100), card('b', 300)])
    const keys = old.flatMap((repo) =>
      repo.chats.map((chat) => `${repo.key}\u0000${chat.key}`),
    )
    expect(
      stableGroupsForEpoch(fresh, keys, 'old-host', 'old-host').map(
        (repo) => repo.key,
      ),
    ).toEqual(['/r/a', '/r/b'])
    expect(
      stableGroupsForEpoch(fresh, keys, 'old-host', 'new-host').map(
        (repo) => repo.key,
      ),
    ).toEqual(['/r/b', '/r/a'])
  })
})
