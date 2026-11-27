import { describe, expect, it } from 'vitest'

import {
  applyTicketCompletion,
  matchSentSuggestions,
  matchTicketSuggestions,
  ticketMentionQuery,
} from '#/features/composer-suggest'
import type { SentRecord } from '#/features/sent-history-data'
import type { CollabTicket } from '#/lib/runtime-contract'

const makeSent = (
  overrides: Partial<SentRecord> & { id: string; text: string },
): SentRecord => ({
  kind: 'message',
  created_at: 1_000,
  status: 'confirmed',
  transcript_end_at_send: 0,
  ...overrides,
})

const makeTicket = (
  id: string,
  title: string,
  attachmentsCount = 0,
): CollabTicket => ({
  id,
  title,
  from: 'web',
  to: 'wezdeck',
  repos: ['wezdeck'],
  status: 'submitted',
  phase: 'intake',
  owner: 'worker',
  parent: null,
  kind: 'ticket',
  created_at: '2026-11-27T00:00:00Z',
  updated_at: '2026-11-27T00:00:00Z',
  worktree: null,
  branch: null,
  runs: 0,
  running: [],
  attachments_count: attachmentsCount,
})

describe('ticketMentionQuery & applyTicketCompletion', () => {
  it('triggers on # at start or after whitespace and supports Chinese', () => {
    expect(ticketMentionQuery('#抖动', 3)).toEqual({ start: 0, query: '抖动' })
    expect(ticketMentionQuery('看看 #req-12', 10)).toEqual({
      start: 3,
      query: 'req-12',
    })
    expect(ticketMentionQuery('foo#bar', 7)).toBeNull()
    expect(ticketMentionQuery('#done next', 10)).toBeNull()
  })

  it('replaces the #query token cleanly with trailing space', () => {
    const out = applyTicketCompletion('请处理 #抖动 一下', 4, 7, 'req-123')
    expect(out.text).toBe('请处理 req-123 一下')
    expect(out.caret).toBe(11)
  })
})

describe('matchTicketSuggestions', () => {
  it('ranks id prefix, then title prefix, then substring', () => {
    const tickets = [
      makeTicket('req-20261127-001', '修复弹窗抖动', 2),
      makeTicket('req-20261127-002', '抖动回归检查', 0),
      makeTicket('req-20261127-003', '无关标题', 0),
    ]
    const hits = matchTicketSuggestions(tickets, '抖动')
    expect(hits.map((h) => h.id)).toEqual([
      'req-20261127-002',
      'req-20261127-001',
    ])
    expect(hits[1].attachmentsCount).toBe(2)
  })
})

describe('matchSentSuggestions', () => {
  it('ignores short inputs, slash commands, dismissed items and exact matches', () => {
    const recs = [
      makeSent({
        id: '1',
        text: '修复弹窗抖动问题',
        session_id: 's1',
        created_at: 200,
      }),
      makeSent({
        id: '2',
        text: '/compact',
        session_id: 's1',
        created_at: 300,
      }),
      makeSent({
        id: '3',
        text: '修复弹窗抖动',
        session_id: 's1',
        status: 'dismissed',
        created_at: 400,
      }),
    ]
    expect(matchSentSuggestions(recs, '修', 's1')).toEqual([])
    expect(matchSentSuggestions(recs, '/co', 's1')).toEqual([])
    expect(matchSentSuggestions(recs, '修复弹窗抖动问题', 's1')).toEqual([])
    expect(
      matchSentSuggestions(recs, '修复弹窗', 's1').map((r) => r.id),
    ).toEqual(['1'])
  })

  it('prefers current session, prefix match, and deduplicates keeping newest', () => {
    const recs = [
      makeSent({
        id: 'old-other',
        text: '部署到线上验证',
        session_id: 's2',
        created_at: 100,
      }),
      makeSent({
        id: 'new-other',
        text: '部署到线上验证',
        session_id: 's2',
        created_at: 500,
      }),
      makeSent({
        id: 'cur-sub',
        text: '先跑测试再部署到线上',
        session_id: 's1',
        created_at: 200,
      }),
      makeSent({
        id: 'cur-pre',
        text: '部署到线上并检查日志',
        session_id: 's1',
        attachments: ['img-1.png'],
        created_at: 150,
      }),
    ]
    const hits = matchSentSuggestions(recs, '部署到线上', 's1')
    expect(hits.map((h) => h.id)).toEqual(['cur-pre', 'cur-sub', 'new-other'])
    expect(hits[0].attachments).toEqual(['img-1.png'])
  })
})
