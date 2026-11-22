import { describe, expect, it } from 'vitest'

import { buildSessionTree } from '#/features/session-order'
import type { SessionCard } from '#/features/console-sessions'

const card = (over: Partial<SessionCard>): SessionCard => ({
  id: 'x',
  agent: 'claude',
  name: 'claude',
  window: '',
  cwd: '/r/a',
  branch: '',
  status: 'idle',
  last_prompt: '',
  ts: 0,
  transcript: true,
  desk_idle_s: 0,
  ...over,
})

describe('session order follows visits, not output', () => {
  const rows = [
    card({
      id: 'a',
      repo: 'alpha',
      repo_root: '/r/a',
      worktree: '/r/a',
      visited: 100,
      ts: 9_000,
    }),
    card({
      id: 'b',
      repo: 'beta',
      repo_root: '/r/b',
      worktree: '/r/b',
      visited: 200,
      ts: 1,
    }),
    card({
      id: 'c',
      repo: 'gamma',
      repo_root: '/r/c',
      worktree: '/r/c',
      ts: 99_999,
    }),
  ]
  const order = (tree: ReturnType<typeof buildSessionTree>) =>
    tree.map((repo) => repo.label)

  it('latest desk visit first; never-visited sink, by name', () => {
    expect(order(buildSessionTree(rows))).toEqual(['beta', 'alpha', 'gamma'])
  })
  it('a new turn (ts) does not move a row', () => {
    const busier = rows.map((row) => ({ ...row, ts: row.ts + 1_000_000 }))
    busier[0] = { ...busier[0], ts: 10 ** 12 }
    expect(order(buildSessionTree(busier))).toEqual(['beta', 'alpha', 'gamma'])
  })
  it('a visit from the phone counts', () => {
    expect(order(buildSessionTree(rows, { '/r/c': 300 }))).toEqual([
      'gamma',
      'beta',
      'alpha',
    ])
  })
  it('within a worktree: primary before secondary', () => {
    const tree = buildSessionTree([
      card({
        id: 's',
        worktree: '/r/a',
        pane_role: 'secondary',
        pane_index: 2,
      }),
      card({ id: 'p', worktree: '/r/a', pane_role: 'primary', pane_index: 1 }),
    ])
    expect(tree[0].worktrees[0].rows.map((row) => row.id)).toEqual(['p', 's'])
  })
})
