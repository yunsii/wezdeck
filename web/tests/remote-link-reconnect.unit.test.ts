import { describe, expect, it } from 'vitest'

import {
  NotApprovedError,
  OPEN_ACTIONS,
  isTransientReconnectError,
  retriable,
} from '#/lib/remote-auth'

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
})
