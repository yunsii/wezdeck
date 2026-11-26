import { describe, expect, it } from 'vitest'

import {
  buildChatGroups,
  chatMatchesQuery,
  chatPreview,
  chatTone,
  resolveChatFocus,
  unreadChatCount,
} from '#/features/session-chats'
import {
  chatTimeBucket,
  formatChatClock,
  formatChatDate,
} from '#/features/chat-time'
import { directionForWorktree } from '#/features/session-new-direction'
import type { SessionCard } from '#/features/console-sessions'
import type { Direction } from '#/features/session-new-direction'

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

const previewLabels = {
  waiting: 'Waiting on you',
  needsConfirm: 'Needs a decision',
  working: 'Replying…',
  empty: 'No human message yet',
}

describe('chatTone / chatPreview', () => {
  it('marks waiting and running for the IM preview line', () => {
    const wait = card({
      status: 'waiting',
      waiting_kind: 'permission',
      last_prompt: 'allow bash?',
    })
    const run = card({
      status: 'running',
      last_prompt: 'hello',
      ts: Date.now(),
    })
    const idle = card({ status: 'idle', last_prompt: 'done turn' })
    expect(chatTone(wait)).toBe('waiting')
    expect(chatTone(run)).toBe('running')
    expect(chatTone(idle)).toBe('idle')
    expect(chatPreview(wait, previewLabels)).toBe(
      'Waiting on you · allow bash?',
    )
    expect(chatPreview(run, previewLabels)).toBe('Replying… · hello')
    expect(chatPreview(idle, previewLabels)).toBe('done turn')
    expect(
      chatPreview(card({ status: 'running', last_prompt: '' }), previewLabels),
    ).toBe('Replying…')
    expect(
      chatPreview(
        card({ status: 'waiting', waiting_kind: 'ask', last_prompt: '' }),
        previewLabels,
      ),
    ).toBe('Waiting on you · Needs a decision')
  })
})

describe('chatMatchesQuery', () => {
  it('matches title, purpose, and preview', () => {
    const groups = buildChatGroups([
      card({
        id: 's1',
        worktree: '/r/a/.worktrees/ux',
        cwd: '/r/a/.worktrees/ux',
        last_prompt: 'wire search',
        worktree_description: 'list polish',
      }),
    ])
    const chat = groups[0].chats[0]
    expect(chatMatchesQuery(chat, 'ux', 'wire search')).toBe(true)
    expect(chatMatchesQuery(chat, 'polish', 'wire search')).toBe(true)
    expect(chatMatchesQuery(chat, 'wire', 'wire search')).toBe(true)
    expect(chatMatchesQuery(chat, 'zzz', 'wire search')).toBe(false)
    expect(chatMatchesQuery(chat, '  ', 'wire search')).toBe(true)
  })
})

describe('chatTimeBucket', () => {
  it('buckets today / yesterday / older', () => {
    const now = new Date('2026-11-26T15:00:00').getTime()
    const today = new Date('2026-11-26T09:30:00').getTime()
    const yesterday = new Date('2026-11-25T22:00:00').getTime()
    const week = new Date('2026-11-23T12:00:00').getTime()
    const older = new Date('2026-10-01T12:00:00').getTime()
    expect(chatTimeBucket(today, now)).toBe('today')
    expect(chatTimeBucket(yesterday, now)).toBe('yesterday')
    expect(chatTimeBucket(week, now)).toBe('weekday')
    expect(chatTimeBucket(older, now)).toBe('date')
    expect(formatChatClock(today, 'en')).toMatch(/\d/)
    expect(formatChatDate(older, 'en')).toMatch(/\d/)
  })
})

describe('directionForWorktree', () => {
  it('returns the direction that owns a parallel slot path', () => {
    const dirs: Array<Direction> = [
      {
        name: 'ux',
        idle: 1,
        slots: [
          {
            path: '/r/a/.worktrees/ux',
            name: 'ux',
            branch: 'dev/ux',
            state: 'idle',
          },
          {
            path: '/r/a/.worktrees/ux-2',
            name: 'ux-2',
            branch: 'dev/ux-2',
            state: 'running',
          },
        ],
      },
    ]
    expect(directionForWorktree(dirs, '/r/a/.worktrees/ux-2', 'ux-2')).toBe(
      'ux',
    )
    expect(directionForWorktree(dirs, '/missing', 'fallback')).toBe('fallback')
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
