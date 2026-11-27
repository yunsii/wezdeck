import { describe, expect, it } from 'vitest'

import {
  earlierPageSize,
  shouldAutoPreload,
} from '../src/features/chat-preload'
import { PAGE } from '../src/lib/session-cache'

const base = {
  start: 60,
  pagingIn: false,
  atCompaction: false,
  failedAt: null,
  scrollTop: 300,
  prevScrollTop: 420,
  clientHeight: 800,
  scrollHeight: 3000,
  userScrolled: true,
}

describe('chat auto-preload trigger', () => {
  it('fires when scrolling upward into the top preload zone after user scroll', () => {
    expect(shouldAutoPreload(base)).toBe(true)
    expect(
      shouldAutoPreload({ ...base, scrollTop: 30, prevScrollTop: 30 }),
    ).toBe(true)
  })

  it('stays quiet before user scroll, while scrolling down, or far from top', () => {
    expect(shouldAutoPreload({ ...base, userScrolled: false })).toBe(false)
    expect(
      shouldAutoPreload({ ...base, scrollTop: 320, prevScrollTop: 260 }),
    ).toBe(false)
    expect(
      shouldAutoPreload({ ...base, scrollTop: 900, prevScrollTop: 950 }),
    ).toBe(false)
    expect(
      shouldAutoPreload({ ...base, scrollHeight: 810, clientHeight: 800 }),
    ).toBe(false)
  })

  it('stops at compaction boundary, while paging, at start=0, or after failure at same start', () => {
    expect(shouldAutoPreload({ ...base, start: 0 })).toBe(false)
    expect(shouldAutoPreload({ ...base, pagingIn: true })).toBe(false)
    expect(shouldAutoPreload({ ...base, atCompaction: true })).toBe(false)
    expect(shouldAutoPreload({ ...base, failedAt: 60 })).toBe(false)
    expect(shouldAutoPreload({ ...base, failedAt: 120 })).toBe(true)
  })

  it('caps earlier page size at the compaction boundary until crossing it', () => {
    expect(earlierPageSize(90, undefined, false)).toBe(PAGE)
    expect(earlierPageSize(90, 75, false)).toBe(15)
    expect(earlierPageSize(75, 75, true)).toBe(PAGE)
  })
})
