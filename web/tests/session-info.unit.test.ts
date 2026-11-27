import { describe, expect, it } from 'vitest'

import {
  buildOverviewRows,
  buildTechnicalGroups,
  buildUsageSummaryRows,
  formatMetaValue,
} from '#/features/session-info-meta'
import type { Detail } from '#/features/console-sessions'

const sampleDetail = (over: Partial<Detail> = {}): Detail => ({
  id: 'sess-123',
  status: 'idle',
  mode: 'auto',
  total: 42,
  messages: [{ role: 'user', text: 'hi' }],
  meta: [
    {
      name: 'session',
      rows: [
        { key: 'id', value: 'sess-123' },
        { key: 'model', value: 'claude-opus-4-5' },
        { key: 'effort', value: 'high' },
      ],
    },
    {
      name: 'location',
      rows: [
        { key: 'cwd', value: '/home/yuns/github/wezdeck' },
        { key: 'tmux_pane', value: '%1' },
      ],
    },
    {
      name: 'transcript',
      rows: [
        { key: 'path', value: '/tmp/t.jsonl' },
        { key: 'bytes', value: '20480' },
      ],
    },
  ],
  usage: {
    model: 'claude-opus-4-5',
    context: 50_000,
    context_limit: 200_000,
    turns: 3,
    output: 4_200,
    input: 10_000,
    cache_read: 90_000,
  },
  token_rate: {
    tok_per_s: 88.6,
    last_tok_per_s: 90,
    samples: 3,
    decode_tok_per_s: 102.4,
    ttft_ms: 620,
    source: 'otel',
  },
  account: {
    five_hour: { used_percentage: 32 },
    seven_day: { used_percentage: 18 },
    at: Date.now(),
  },
  capabilities: {
    ask_options: true,
    plan_review: true,
    usage: 'transcript',
    account_limits: true,
    mid_turn_input: 'queue',
    title: true,
  },
  ...over,
})

describe('session info projection', () => {
  it('distills overview rows to status+mode, model+effort, and cwd', () => {
    const rows = buildOverviewRows(sampleDetail(), '空闲')
    expect(rows).toEqual([
      { key: 'status', value: '空闲 · auto' },
      { key: 'model', value: 'claude-opus-4-5 · high' },
      { key: 'cwd', value: '/home/yuns/github/wezdeck' },
    ])
  })

  it('builds compact usage summary rows with context, output+rate+cache, and limits', () => {
    const rows = buildUsageSummaryRows(sampleDetail(), {
      compacted: 'Just compacted',
      cache: '缓存',
    })
    expect(rows.map((r) => r.key)).toEqual(['context', 'output', 'limits'])
    expect(rows[0].value).toContain('(25%)')
    expect(rows[1].value).toContain('4,200')
    expect(rows[1].value).toContain('88.6 tok/s')
    expect(rows[1].value).toContain('缓存 90%')
    expect(rows[2].value).toBe('5h 32% · 7d 18%')
  })

  it('preserves every diagnostic group and loaded count in technical details', () => {
    const groups = buildTechnicalGroups(sampleDetail(), {
      yes: '是',
      no: '否',
      steer: '并入当前轮',
      queue: '排队发送',
    })
    expect(groups.map((g) => g.name)).toEqual([
      'session',
      'location',
      'transcript',
      'usage',
      'capabilities',
    ])
    const transcript = groups.find((g) => g.name === 'transcript')!
    expect(transcript.rows.at(-1)).toEqual({ key: 'loaded', value: '1 / 42' })
    expect(formatMetaValue('bytes', '20480')).toBe('20 KB')
  })
})
