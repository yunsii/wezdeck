import { describe, expect, it } from 'vitest'

import {
  buildChatGroups,
  resolveChatFocus,
  unreadChatCount,
} from '#/features/session-chats'
import type { SessionCard } from '#/features/console-sessions'

const card = (over: Partial<SessionCard>): SessionCard => ({
  id: 'x',
  agent: 'claude',
  name: 'claude',
  window: '',
  cwd: '/r/a/.worktrees/ux',
  branch: 'dev/ux',
  status: 'idle',
  last_prompt: '',
  ts: 0,
  transcript: true,
  desk_idle_s: 0,
  repo: 'wezdeck',
  repo_label: 'wezdeck',
  repo_root: '/r/a',
  worktree: '/r/a/.worktrees/ux',
  ...over,
})

describe('resolveChatFocus', () => {
  it('prefers waiting, then running, then newest ts', () => {
    const rows = [
      card({ id: 'old', ts: 10, status: 'idle' }),
      card({ id: 'run', ts: 20, status: 'running' }),
      card({
        id: 'wait',
        ts: 5,
        status: 'waiting',
        waiting_kind: 'permission',
      }),
    ]
    expect(resolveChatFocus(rows)?.id).toBe('wait')
    expect(resolveChatFocus(rows.filter((row) => row.id !== 'wait'))?.id).toBe(
      'run',
    )
    expect(
      resolveChatFocus([
        card({ id: 'old', ts: 10, status: 'idle' }),
        card({ id: 'newer', ts: 30, status: 'idle' }),
      ])?.id,
    ).toBe('newer')
  })
})

describe('buildChatGroups', () => {
  it('one chat per worktree; parallel slots stay two rows', () => {
    const groups = buildChatGroups([
      card({
        id: 's1',
        worktree: '/r/a/.worktrees/ux',
        cwd: '/r/a/.worktrees/ux',
        last_prompt: 'first',
        ts: 100,
      }),
      card({
        id: 's2',
        worktree: '/r/a/.worktrees/ux',
        cwd: '/r/a/.worktrees/ux',
        last_prompt: 'second',
        ts: 200,
        status: 'waiting',
        waiting_kind: 'ask',
      }),
      card({
        id: 's3',
        worktree: '/r/a/.worktrees/ux-2',
        cwd: '/r/a/.worktrees/ux-2',
        last_prompt: 'parallel',
        ts: 150,
      }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].chats.map((c) => c.title)).toEqual(['ux', 'ux-2'])
    expect(groups[0].chats[0].sessions).toHaveLength(2)
    expect(groups[0].chats[0].focus.id).toBe('s2')
    expect(groups[0].chats[0].unread).toBe(1)
    // unread floats above ux-2
    expect(groups[0].chats[0].key).toContain('/ux')
    expect(groups[0].chats[0].key).not.toContain('ux-2')
  })

  it('primary checkout titles with the repo alias', () => {
    const groups = buildChatGroups([
      card({
        id: 'main',
        worktree: '/r/a',
        cwd: '/r/a',
        repo_root: '/r/a',
        last_prompt: 'on main',
      }),
    ])
    expect(groups[0].chats[0].title).toBe('wezdeck')
  })
})

describe('unreadChatCount', () => {
  it('counts worktrees, not sessions', () => {
    const rows = [
      card({
        id: 'a',
        status: 'waiting',
        waiting_kind: 'ask',
        worktree: '/r/a/.worktrees/ux',
      }),
      card({
        id: 'b',
        status: 'waiting',
        waiting_kind: 'ask',
        worktree: '/r/a/.worktrees/ux',
      }),
      card({
        id: 'c',
        status: 'waiting',
        waiting_kind: 'ask',
        worktree: '/r/a/.worktrees/ci',
        cwd: '/r/a/.worktrees/ci',
      }),
    ]
    expect(unreadChatCount(rows)).toBe(2)
  })
})
