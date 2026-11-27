import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createDelayedLoadingController } from '#/lib/use-delayed-loading'

describe('createDelayedLoadingController', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('never shows skeleton when pending settles before delayMs', () => {
    let visible = false
    const ctrl = createDelayedLoadingController((next) => {
      visible = next
    })

    ctrl.update(true, 'a.md')
    expect(visible).toBe(false)

    vi.advanceTimersByTime(100)
    expect(visible).toBe(false)

    ctrl.update(false, 'a.md')
    vi.advanceTimersByTime(500)
    expect(visible).toBe(false)
    ctrl.dispose()
  })

  it('holds visible skeleton for at least minHoldMs to prevent brief flash', () => {
    let visible = false
    const ctrl = createDelayedLoadingController((next) => {
      visible = next
    })

    ctrl.update(true, 'a.md')
    vi.advanceTimersByTime(150)
    expect(visible).toBe(true)

    // Data arrives 40 ms after skeleton appeared — hold 200 ms more.
    vi.advanceTimersByTime(40)
    ctrl.update(false, 'a.md')
    expect(visible).toBe(true)

    vi.advanceTimersByTime(199)
    expect(visible).toBe(true)

    vi.advanceTimersByTime(1)
    expect(visible).toBe(false)
    ctrl.dispose()
  })

  it('hides immediately once minHoldMs has already elapsed', () => {
    let visible = false
    const ctrl = createDelayedLoadingController((next) => {
      visible = next
    })

    ctrl.update(true, 'a.md')
    vi.advanceTimersByTime(500)
    expect(visible).toBe(true)

    ctrl.update(false, 'a.md')
    expect(visible).toBe(false)
    ctrl.dispose()
  })

  it('resets cleanly when switching to a nested file path', () => {
    let visible = false
    const ctrl = createDelayedLoadingController((next) => {
      visible = next
    })

    ctrl.update(true, 'a.md')
    vi.advanceTimersByTime(150)
    expect(visible).toBe(true)

    ctrl.update(true, 'b.ts')
    expect(visible).toBe(false)

    vi.advanceTimersByTime(150)
    expect(visible).toBe(true)
    ctrl.dispose()
  })
})
