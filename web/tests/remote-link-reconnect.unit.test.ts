import { describe, expect, it } from 'vitest'

import {
  NotApprovedError,
  OPEN_ACTIONS,
  isTransientReconnectError,
  retriable,
} from '#/lib/remote-auth'
import {
  linkEventsSnapshot,
  nextRtcRetryDelay,
  recordLinkEvent,
  resetLinkEvents,
} from '#/lib/remote-link-trace'

describe('remote reconnect retry classification', () => {
  it('classifies pre-execution offline/disconnected errors as transient', () => {
    expect(isTransientReconnectError(new Error('host offline'))).toBe(true)
    expect(isTransientReconnectError(new Error('home host is offline'))).toBe(
      true,
    )
    expect(
      isTransientReconnectError(new Error('remote link is not connected')),
    ).toBe(true)
  })

  it('does not classify auth refusals, timeouts, or domain errors as transient', () => {
    expect(isTransientReconnectError(new NotApprovedError())).toBe(false)
    expect(
      isTransientReconnectError(
        new Error('remote host did not answer in time'),
      ),
    ).toBe(false)
    expect(isTransientReconnectError(new Error('session not found'))).toBe(
      false,
    )
    expect(isTransientReconnectError('host offline')).toBe(false)
  })

  it('keeps signed session.autotitle.update in OPEN_ACTIONS and non-retriable for hello', () => {
    expect(OPEN_ACTIONS.has('session.autotitle.update')).toBe(true)
    expect(retriable(new NotApprovedError(), 'session.autotitle.update')).toBe(
      false,
    )
  })

  it('requires hello and retries diag.submit on NotApprovedError', () => {
    expect(OPEN_ACTIONS.has('diag.submit')).toBe(false)
    expect(retriable(new NotApprovedError(), 'diag.submit')).toBe(true)
  })
})

describe('remote link trace & WebRTC backoff helpers', () => {
  it('backs off WebRTC retries when samePublic is no, keeps base delay otherwise', () => {
    expect(nextRtcRetryDelay('no', 1)).toBe(60_000)
    expect(nextRtcRetryDelay('no', 2)).toBe(180_000)
    expect(nextRtcRetryDelay('no', 3)).toBe(600_000)
    expect(nextRtcRetryDelay('no', 9)).toBe(600_000)
    expect(nextRtcRetryDelay('yes', 5)).toBe(60_000)
    expect(nextRtcRetryDelay(undefined, 5)).toBe(60_000)
  })

  it('caps dedicated linkEvents buffer at 80 entries', () => {
    resetLinkEvents()
    for (let i = 0; i < 95; i++) {
      recordLinkEvent('ws_close', { code: 1006, seq: i })
    }
    const snap = linkEventsSnapshot()
    expect(snap).toHaveLength(80)
    expect(snap[0]?.data?.seq).toBe(15)
    expect(snap.at(-1)?.data?.seq).toBe(94)
  })
})
