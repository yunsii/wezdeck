import { describe, expect, it } from 'vitest'

import {
  buildChatGroups,
  chatMatchesQuery,
  chatPreview,
  chatTone,
  resolveChatFocus,
  unreadChatCount,
  workstationHint,
} from '#/features/session-chats'
import {
  chatTimeBucket,
  formatChatClock,
  formatChatDate,
} from '#/features/chat-time'
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
  it('prefers waiting, then done, then running, then latest stable activity', () => {
    const rows = [
      card({ id: 'old', ts: 10, status: 'idle' }),
      card({ id: 'run', ts: 20, status: 'running' }),
      card({ id: 'done', ts: 15, status: 'done' }),
      card({
        id: 'wait',
        ts: 5,
        status: 'waiting',
        waiting_kind: 'permission',
      }),
    ]
    expect(resolveChatFocus(rows)?.id).toBe('wait')
    expect(resolveChatFocus(rows.filter((row) => row.id !== 'wait'))?.id).toBe(
      'done',
    )
    expect(
      resolveChatFocus(
        rows.filter((row) => row.id !== 'wait' && row.id !== 'done'),
      )?.id,
    ).toBe('run')
    expect(
      resolveChatFocus([
        card({ id: 'old', ts: 10, status: 'idle', pane_index: 0 }),
        card({ id: 'newer', ts: 30, status: 'idle', pane_index: 1 }),
      ])?.id,
    ).toBe('newer')
  })
  it('prefers attached idle sessions without hiding detached work', () => {
    const attached = card({ id: 'attached', ts: 10 })
    const detached = card({ id: 'detached', ts: 30, detached: true })
    expect(resolveChatFocus([detached, attached])?.id).toBe('attached')
    for (const over of [
      { status: 'running' },
      { status: 'done' },
      { status: 'waiting', waiting_kind: 'permission' },
    ]) {
      expect(
        resolveChatFocus([attached, card({ ...detached, ...over })])?.id,
      ).toBe('detached')
    }
  })
  it('follows the primary terminal over an archived done session', () => {
    const archived = card({
      id: 'old-grok',
      agent: 'grok',
      status: 'done',
      ts: 30,
    })
    const terminal = card({
      id: 'agy-live',
      agent: 'agy',
      status: 'done',
      pane_role: 'primary',
      ts: 20,
    })
    expect(resolveChatFocus([archived, terminal])?.id).toBe('agy-live')
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

  it('does not reorder chats when attention refresh timestamps change', () => {
    const rows = [
      card({
        id: 'a',
        worktree: '/r/a/.worktrees/a',
        cwd: '/r/a/.worktrees/a',
        ts: 100,
        order_at: 100,
        visited: 900,
      }),
      card({
        id: 'b',
        worktree: '/r/a/.worktrees/b',
        cwd: '/r/a/.worktrees/b',
        ts: 200,
        order_at: 200,
        visited: 0,
      }),
    ]
    const refreshed = rows.map((row, index) => ({
      ...row,
      ts: 1_000_000 + index,
      visited: index === 0 ? 2_000_000 : 0,
    }))
    const order = (items: Array<SessionCard>) =>
      buildChatGroups(items).flatMap((repo) =>
        repo.chats.map((chat) => chat.key),
      )
    expect(order(rows)).toEqual(['/r/a/.worktrees/b', '/r/a/.worktrees/a'])
    expect(order(refreshed)).toEqual(order(rows))
  })

  it('orders repo groups by turn events instead of opening them', () => {
    const alpha = card({
      id: 'a',
      repo_root: '/alpha',
      repo: 'alpha',
      repo_label: 'alpha',
      order_at: 100,
    })
    const beta = card({
      id: 'b',
      repo_root: '/beta',
      repo: 'beta',
      repo_label: 'beta',
      order_at: 200,
    })
    const order = (rows: Array<SessionCard>) =>
      buildChatGroups(rows).map((repo) => repo.label)
    expect(order([alpha, beta])).toEqual(['beta', 'alpha'])
    expect(order([{ ...alpha, visited: 10_000 }, beta])).toEqual([
      'beta',
      'alpha',
    ])
    expect(order([{ ...alpha, order_at: 300 }, beta])).toEqual([
      'alpha',
      'beta',
    ])
  })
})

const previewLabels = {
  waiting: 'Waiting on you',
  needsConfirm: 'Needs a decision',
  done: 'Done',
  working: 'Working',
  empty: 'No human message yet',
}

describe('chatTone / chatPreview', () => {
  it('marks waiting, done, and running for the IM preview line', () => {
    const wait = card({
      status: 'waiting',
      waiting_kind: 'permission',
      last_prompt: 'allow bash?',
    })
    const done = card({
      status: 'done',
      last_prompt: 'ship it',
      ts: Date.now(),
    })
    const run = card({
      status: 'running',
      last_prompt: 'hello',
      ts: Date.now(),
    })
    const idle = card({ status: 'idle', last_prompt: 'done turn' })
    // idle with a fresh ts must NOT look running (seen-ack → idle)
    const justAcked = card({
      status: 'idle',
      last_prompt: 'ship it',
      ts: Date.now(),
    })
    expect(chatTone(wait)).toBe('waiting')
    expect(chatTone(done)).toBe('done')
    expect(chatTone(run)).toBe('running')
    expect(chatTone(idle)).toBe('idle')
    expect(chatTone(justAcked)).toBe('idle')
    expect(chatPreview(wait, previewLabels)).toBe(
      'Waiting on you · allow bash?',
    )
    expect(chatPreview(done, previewLabels)).toBe('Done · ship it')
    expect(chatPreview(run, previewLabels)).toBe('Working · hello')
    expect(chatPreview(idle, previewLabels)).toBe('done turn')
    expect(chatPreview(justAcked, previewLabels)).toBe('ship it')
    expect(
      chatPreview(card({ status: 'running', last_prompt: '' }), previewLabels),
    ).toBe('Working')
    expect(
      chatPreview(card({ status: 'done', last_prompt: '' }), previewLabels),
    ).toBe('Done')
    expect(
      chatPreview(
        card({ status: 'waiting', waiting_kind: 'ask', last_prompt: '' }),
        previewLabels,
      ),
    ).toBe('Waiting on you · Needs a decision')
  })

  it('does not call a freshly created empty session a running reply', () => {
    const now = Date.now()
    const fresh = card({ id: 'fresh-empty', status: 'idle', ts: now })
    expect(chatTone(fresh, now)).toBe('idle')
    expect(chatPreview(fresh, previewLabels, now)).toBe('No human message yet')
    expect(
      resolveChatFocus([
        fresh,
        card({
          id: 'recent-turn',
          status: 'idle',
          last_prompt: 'finished work',
          ts: now - 1_000,
        }),
      ])?.id,
    ).toBe('fresh-empty')
  })

  it('keeps the running preview when the composer has an unsent draft', () => {
    expect(
      chatPreview(
        card({ status: 'running', last_prompt: 'sent', draft: 'unsent reply' }),
        previewLabels,
      ),
    ).toBe('Working · sent')
  })
})

describe('unreadChatCount', () => {
  it('counts only worktrees with sessions waiting on a person', () => {
    expect(
      unreadChatCount([
        card({ id: 'a', status: 'done', worktree: '/r/a/.worktrees/ux' }),
        card({
          id: 'b',
          status: 'waiting',
          waiting_kind: 'ask',
          worktree: '/r/a/.worktrees/ux-2',
        }),
        card({ id: 'c', status: 'idle', worktree: '/r/a/.worktrees/ux-3' }),
        card({
          id: 'd',
          status: 'done',
          worktree: '/r/a/.worktrees/ux',
        }),
      ]),
    ).toBe(1)
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

  it('matches a non-focus session of a multi-session worktree', () => {
    const groups = buildChatGroups([
      card({
        id: 'g1',
        agent: 'grok',
        name: 'grok',
        title: 'sync fix',
        last_prompt: 'grok prompt',
        status: 'running',
        ts: 100,
      }),
      card({
        id: 'c1',
        agent: 'codex',
        name: 'codex',
        title: 'relay review',
        last_prompt: 'codex prompt',
        status: 'idle',
        ts: 200,
      }),
    ])
    const chat = groups[0].chats[0]
    expect(chat.sessions).toHaveLength(2)
    expect(chat.focus.id).toBe('g1')
    expect(chatMatchesQuery(chat, 'codex', '')).toBe(true)
    expect(chatMatchesQuery(chat, 'relay review', '')).toBe(true)
    expect(chatMatchesQuery(chat, 'codex prompt', '')).toBe(true)
    expect(chatMatchesQuery(chat, 'nomatch', '')).toBe(false)
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

describe('workstationHint', () => {
  it('prefers explicit purpose, falls back to named direction, hides auto slugs and primary', () => {
    expect(
      workstationHint({
        title: 'session-b5b3c61bc47586c5',
        purpose: '移动端优化',
        editable: true,
      }),
    ).toBe('移动端优化')
    expect(
      workstationHint({
        title: 'ux',
        purpose: '',
        editable: true,
      }),
    ).toBe('ux')
    expect(
      workstationHint({
        title: 'session-b5b3c61bc47586c5',
        purpose: '',
        editable: true,
      }),
    ).toBe('')
    expect(
      workstationHint({
        title: 'wezdeck',
        purpose: '',
        editable: false,
      }),
    ).toBe('')
  })
})
