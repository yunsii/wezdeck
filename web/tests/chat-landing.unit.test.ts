import { describe, expect, it } from 'vitest'

import {
  landingPolicy,
  nextBaseline,
  resolveLanding,
  resolveLandingPreference,
  shouldLandLatestTop,
} from '#/features/chat-landing'
import { hasPromptPanel } from '#/features/session-elicitation'
import type { Detail } from '#/features/console-sessions'

describe('shouldLandLatestTop (newly done and running sessions)', () => {
  it('is true for done or running sessions with no pending send or prompt card', () => {
    expect(
      shouldLandLatestTop({
        status: 'done',
        pendingCount: 0,
        hasPrompt: false,
      }),
    ).toBe(true)
    expect(
      shouldLandLatestTop({
        status: 'running',
        pendingCount: 0,
        hasPrompt: false,
      }),
    ).toBe(true)
  })

  it('is false on subsequent opens (idle) or waiting / pending states', () => {
    expect(
      shouldLandLatestTop({
        status: 'idle',
        pendingCount: 0,
        hasPrompt: false,
      }),
    ).toBe(false)
    expect(
      shouldLandLatestTop({
        status: 'done',
        pendingCount: 1,
        hasPrompt: false,
      }),
    ).toBe(false)
    expect(
      shouldLandLatestTop({
        status: 'running',
        pendingCount: 0,
        hasPrompt: true,
      }),
    ).toBe(false)
  })
})

describe('resolveLandingPreference (auto seen-ack done→idle never snaps to bottom)', () => {
  it('keeps latest-top latched when done flips to idle during the landing window', () => {
    const initial = landingPolicy({
      status: 'done',
      pendingCount: 0,
      hasPrompt: false,
    })
    const onOpen = resolveLandingPreference({
      wasLatched: false,
      preferLatestTop: initial.preferLatestTop,
      forceBottom: Boolean(initial.forceBottom),
    })
    expect(onOpen).toBe(true)
    // 1.5s later useSeenAck flips status done → idle (preferLatestTop becomes false)
    const afterAckPolicy = landingPolicy({
      status: 'idle',
      pendingCount: 0,
      hasPrompt: false,
    })
    const afterSeenAck = resolveLandingPreference({
      wasLatched: onOpen,
      preferLatestTop: afterAckPolicy.preferLatestTop,
      forceBottom: Boolean(afterAckPolicy.forceBottom),
    })
    expect(afterSeenAck).toBe(true)
    // Queuing a new reply forces bottom and releases the latch
    const afterSendPolicy = landingPolicy({
      status: 'idle',
      pendingCount: 1,
      hasPrompt: false,
    })
    expect(
      resolveLandingPreference({
        wasLatched: afterSeenAck,
        preferLatestTop: afterSendPolicy.preferLatestTop,
        forceBottom: Boolean(afterSendPolicy.forceBottom),
      }),
    ).toBe(false)
  })

  it('releases the latch when a new message is queued or a prompt card appears', () => {
    expect(
      resolveLandingPreference({
        wasLatched: true,
        preferLatestTop: false,
        forceBottom: true,
      }),
    ).toBe(false)
  })

  it('keeps idle reopens landing directly at the bottom', () => {
    expect(
      resolveLandingPreference({
        wasLatched: false,
        preferLatestTop: false,
        forceBottom: false,
      }),
    ).toBe(false)
  })

  it('never flips from bottom to latest-top after dismissing a permission prompt', () => {
    const waiting = landingPolicy({
      status: 'waiting',
      pendingCount: 0,
      hasPrompt: true,
    })
    const onOpen = resolveLandingPreference({
      wasLatched: false,
      preferLatestTop: waiting.preferLatestTop,
      forceBottom: Boolean(waiting.forceBottom),
      lockedBottom: Boolean(waiting.forceBottom),
    })
    expect(onOpen).toBe(false)
    // User clicks Allow within the landing window -> status flips waiting → running, hasPrompt → false
    const afterAllow = landingPolicy({
      status: 'running',
      pendingCount: 0,
      hasPrompt: false,
    })
    expect(afterAllow.preferLatestTop).toBe(true)
    expect(
      resolveLandingPreference({
        wasLatched: onOpen,
        preferLatestTop: afterAllow.preferLatestTop,
        forceBottom: Boolean(afterAllow.forceBottom),
        lockedBottom: true,
      }),
    ).toBe(false)
  })
})

describe('nextBaseline (no streaming animation for initial post-mount catch-up)', () => {
  it('advances baseline while syncing and on the render syncing completes, then locks', () => {
    // mount with stale IndexedDB cache (10 msgs), initial fetch in flight
    const r1 = nextBaseline(null, 10, 10, true, true)
    expect(r1).toBe(10)
    // mount fetch returns 13 msgs (3 completed while away): renders statically
    const r2 = nextBaseline(r1, 13, 13, false, true)
    expect(r2).toBe(13)
    // subsequent live poll brings msg 14: baseline stays locked at 13 so it streams
    const r3 = nextBaseline(r2, 14, 14, false, false)
    expect(r3).toBe(13)
  })

  it('locks immediately on first non-empty render when not syncing (demos / offline)', () => {
    const r1 = nextBaseline(null, 5, 5, false, false)
    expect(r1).toBe(5)
    expect(nextBaseline(r1, 6, 6, false, false)).toBe(5)
  })
})

describe('resolveLanding (opening a session lands at latest-message top when it overflows)', () => {
  it('always lands at bottom when rawTarget is null (busy / idle / prompt card)', () => {
    expect(resolveLanding({ bottom: 1200, rawTarget: null })).toEqual({
      top: 1200,
      pinned: true,
      mode: 'bottom',
    })
  })

  it('lands at bottom when the thread does not scroll', () => {
    expect(
      resolveLanding({ bottom: 0, rawTarget: 0, hasUserAbove: true }),
    ).toEqual({
      top: 0,
      pinned: true,
      mode: 'bottom',
    })
  })

  it('lands at bottom when the latest message already fits on screen', () => {
    expect(
      resolveLanding({ bottom: 2000, rawTarget: 2200, hasUserAbove: true }),
    ).toEqual({
      top: 2000,
      pinned: true,
      mode: 'bottom',
    })
    expect(
      resolveLanding({ bottom: 2000, rawTarget: 1996, hasUserAbove: true }),
    ).toEqual({
      top: 2000,
      pinned: true,
      mode: 'bottom',
    })
  })

  it('lands at the latest message start with StickyPrompt clearance when it overflows past NEAR_BOTTOM', () => {
    expect(
      resolveLanding({
        bottom: 2000,
        rawTarget: 1300,
        bar: 52,
        hasUserAbove: true,
      }),
    ).toEqual({
      top: 1248,
      pinned: false,
      mode: 'latest-top',
    })
  })

  it('does not reserve StickyPrompt clearance when no user prompt sits above', () => {
    expect(
      resolveLanding({
        bottom: 2000,
        rawTarget: 1300,
        bar: 52,
        hasUserAbove: false,
      }),
    ).toEqual({
      top: 1300,
      pinned: false,
      mode: 'latest-top',
    })
  })

  it('keeps pinned (no StickyPrompt / JumpLatest) when overflow is tiny (< NEAR_BOTTOM)', () => {
    expect(
      resolveLanding({
        bottom: 2000,
        rawTarget: 1975,
        bar: 52,
        hasUserAbove: true,
      }),
    ).toEqual({
      top: 1975,
      pinned: true,
      mode: 'latest-top',
    })
  })

  it('clamps negative targets to 0', () => {
    expect(
      resolveLanding({
        bottom: 600,
        rawTarget: 20,
        bar: 52,
        hasUserAbove: true,
      }),
    ).toEqual({
      top: 0,
      pinned: false,
      mode: 'latest-top',
    })
  })
})

describe('hasPromptPanel (keeps bottom landing when an interactive card waits)', () => {
  const base = (patch: Partial<Detail> = {}): Detail => ({
    id: 's1',
    status: 'done',
    ...patch,
  })

  it('is false for completed or idle sessions with no prompt card', () => {
    expect(hasPromptPanel(undefined)).toBe(false)
    expect(hasPromptPanel(base({ status: 'done' }))).toBe(false)
    expect(hasPromptPanel(base({ status: 'idle' }))).toBe(false)
    expect(
      hasPromptPanel(
        base({
          status: 'done',
          elicitation: { questions: [{ question: 'q', options: [] }] },
          plan: { awaiting_approval: true },
        }),
      ),
    ).toBe(false)
  })

  it('is true for waiting permission, ask, plan review, or waiting_kind', () => {
    expect(
      hasPromptPanel(base({ status: 'waiting', waiting_kind: 'permission' })),
    ).toBe(true)
    expect(
      hasPromptPanel(
        base({
          status: 'waiting',
          permission: { tool: 'Bash', text: 'ls' },
        }),
      ),
    ).toBe(true)
    expect(
      hasPromptPanel(
        base({
          status: 'waiting',
          elicitation: { questions: [{ question: 'q', options: [] }] },
        }),
      ),
    ).toBe(true)
    expect(
      hasPromptPanel(
        base({ status: 'waiting', plan: { awaiting_approval: true } }),
      ),
    ).toBe(true)
  })
})
