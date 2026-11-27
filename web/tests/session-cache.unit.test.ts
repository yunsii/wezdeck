import { describe, expect, it } from 'vitest'

import {
  DISK_KEEP,
  mergeReply,
  pollArgs,
  trimForDisk,
} from '../src/lib/session-cache'

const msgs = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => ({ i: from + i }))
const page = (start: number, to: number, span: string, extra = {}) => ({
  start,
  messages: msgs(start, to),
  span,
  status: 'idle',
  ...extra,
})

describe('session cache', () => {
  it('asks for a first page, then only the tail', () => {
    expect(pollArgs('s')).toEqual({ id: 's', limit: 60 })
    expect(pollArgs('s', page(40, 100, 'full'))).toEqual({
      id: 's',
      since: 100,
      messages_rev: 0,
    })
  })
  it('since: keeps what came before, takes the rest and the new status', () => {
    const have = page(40, 100, 'full')
    // the host reached back to a pending call at 90
    const got = mergeReply(have, page(90, 103, 'since', { status: 'running' }))
    expect(got.start).toBe(40)
    expect(got.messages.map((m) => m.i)).toEqual(msgs(40, 103).map((m) => m.i))
    expect(got.status).toBe('running')
  })
  it('since with a gap or before our start: start over from the reply', () => {
    const have = page(40, 100, 'full')
    expect(mergeReply(have, page(120, 130, 'since')).start).toBe(120)
    expect(mergeReply(have, page(10, 30, 'since')).start).toBe(10)
  })
  it('before: goes in front, keeps the latest status we had', () => {
    const have = page(60, 100, 'since', { status: 'running' })
    const got = mergeReply(have, page(0, 60, 'before', { status: 'stale' }))
    expect(got.start).toBe(0)
    expect(got.messages).toHaveLength(100)
    expect(got.status).toBe('running')
    // an overlapping earlier page adds only what we lacked
    expect(mergeReply(have, page(30, 80, 'before')).messages).toHaveLength(70)
    // not contiguous: ignored
    expect(mergeReply(have, page(0, 20, 'before')).start).toBe(60)
  })
  it('full (and replies from an older host) replace', () => {
    const have = page(40, 100, 'since')
    expect(mergeReply(have, page(50, 110, 'full')).start).toBe(50)
    const { span: _drop, ...old } = page(50, 110, 'full')
    expect(mergeReply(have, old).start).toBe(50)
  })
  it('replaces a cached transcript after its message revision changes', () => {
    const old = page(0, 10, 'full')
    const refreshed = { ...page(0, 9, 'full'), messages_rev: 1 }
    const have = mergeReply(old, refreshed)
    expect(have).toEqual(refreshed)
    expect(pollArgs('s', have)).toEqual({
      id: 's',
      since: 9,
      messages_rev: 1,
    })
    expect(mergeReply(have, page(0, 2, 'before'))).toBe(have)
  })
  it('disk copy keeps the newest messages with the right start', () => {
    const big = page(0, DISK_KEEP + 50, 'since')
    const disk = trimForDisk(big)
    expect(disk.messages).toHaveLength(DISK_KEEP)
    expect(disk.start).toBe(50)
    expect(trimForDisk(page(0, 10, 'full')).messages).toHaveLength(10)
  })
  it('disk copy extends back to keep the latest user message when a turn exceeds DISK_KEEP', () => {
    const longTurn = {
      start: 0,
      span: 'since',
      messages: Array.from({ length: DISK_KEEP + 40 }, (_, i) => ({
        role: i === 15 ? 'user' : 'tool',
        text: `m${i}`,
      })),
    }
    const disk = trimForDisk(longTurn)
    expect(disk.start).toBe(15)
    expect(disk.messages[0]).toEqual({ role: 'user', text: 'm15' })
    expect(disk.messages).toHaveLength(DISK_KEEP + 25)
  })
})
