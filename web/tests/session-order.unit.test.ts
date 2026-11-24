import { describe, expect, it } from 'vitest'

import {
  RECENT_MS,
  buildSessionTree,
  inRunning,
  nextInCycle,
} from '#/features/session-order'
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

describe('Alt+j style cycling', () => {
  it('goes to the next one after the current, wrapping', () => {
    expect(nextInCycle(['a', 'b', 'c'], 'b')).toBe('c')
    expect(nextInCycle(['a', 'b', 'c'], 'c')).toBe('a')
    expect(nextInCycle(['a', 'b', 'c'], 'a', -1)).toBe('c')
  })
  it('from a session outside the set: the first (or last going back)', () => {
    expect(nextInCycle(['a', 'b'], 'z')).toBe('a')
    expect(nextInCycle(['a', 'b'], 'z', -1)).toBe('b')
  })
  it('nothing else to go to: silent, like Alt+j with none waiting', () => {
    expect(nextInCycle([], 'a')).toBeUndefined()
    expect(nextInCycle(['a'], 'a')).toBeUndefined()
  })
})

describe('repo names follow the desk aliases', () => {
  it('the repo and its main checkout show the alias; other worktrees keep theirs', () => {
    const tree = buildSessionTree([
      card({
        id: 'm',
        repo: 'wezterm-config',
        repo_label: 'wezdeck',
        repo_root: '/g/wezterm-config',
        worktree: '/g/wezterm-config',
        cwd: '/g/wezterm-config',
      }),
      card({
        id: 'w',
        repo: 'wezterm-config',
        repo_label: 'wezdeck',
        repo_root: '/g/wezterm-config',
        worktree: '/g/wt/dev-ui',
        cwd: '/g/wt/dev-ui',
      }),
    ])
    expect(tree).toHaveLength(1)
    expect(tree[0]?.label).toBe('wezdeck')
    expect(tree[0]?.worktrees.map((wt) => wt.label).sort()).toEqual([
      'dev-ui',
      'wezdeck',
    ])
  })

  it('no alias: the basename as before', () => {
    const tree = buildSessionTree([
      card({ id: 'a', repo: 'fe1', repo_root: '/g/fe1', worktree: '/g/fe1' }),
    ])
    expect(tree[0]?.label).toBe('fe1')
  })
})

describe('inRunning (运行中)', () => {
  const now = 10_000_000
  it('mid-turn is running; background-only is not', () => {
    expect(inRunning(card({ status: 'running', ts: 0 }), now)).toBe(true)
    expect(
      inRunning(
        card({ status: 'running', running_kind: 'background', ts: 0 }),
        now,
      ),
    ).toBe(false)
  })
  it('keeps a turn that ended under RECENT_MS ago, then lets it go', () => {
    expect(inRunning(card({ status: 'idle', ts: now - 1_000 }), now)).toBe(true)
    expect(
      inRunning(card({ status: 'idle', ts: now - RECENT_MS - 1 }), now),
    ).toBe(false)
  })
  it('waiting on you is never running, however recent', () => {
    expect(inRunning(card({ status: 'waiting', ts: now }), now)).toBe(false)
    expect(
      inRunning(
        card({ status: 'running', waiting_kind: 'question', ts: now }),
        now,
      ),
    ).toBe(false)
  })
})
