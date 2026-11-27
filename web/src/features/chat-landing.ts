// Initial landing geometry for a session conversation: normally a thread lands
// at its bottom, but when a session has just finished (`done`, with no waiting
// prompt card or pending send) and the newest message itself is taller than the
// visible viewport, landing strictly at the bottom clips its start off the top
// and leaves only its tail on screen. Land at the start of the latest message
// in that case — leaving room for StickyPrompt when unpinned — while later
// visits (`idle`) and live/waiting sessions land directly at the bottom.
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'

import { trace } from '#/lib/client-trace'
import { BAR } from './chat-sticky'

export const NEAR_BOTTOM = 48

export type LandingDecision = {
  top: number
  pinned: boolean
  mode: 'bottom' | 'latest-top'
}

/**
 * Newly completed (`done`) and active (`running`) sessions open from the start
 * of a tall latest message; subsequent opens (`idle`), pending sends and
 * waiting prompt cards land directly at the bottom.
 */
export function shouldLandLatestTop({
  status,
  pendingCount,
  hasPrompt,
}: {
  status?: string
  pendingCount: number
  hasPrompt: boolean
}): boolean {
  return (
    (status === 'done' || status === 'running') &&
    pendingCount === 0 &&
    !hasPrompt
  )
}

/**
 * Reveal baseline for ChatThread: while the first post-mount fetch is still
 * catching up from a persisted IndexedDB snapshot (`syncing` or the render
 * where it just finished), follow `end` so already-completed messages render
 * statically instead of replaying through the live stream animation. Once
 * settled, lock `baseline` so subsequent live polls animate as they arrive.
 */
export function nextBaseline(
  prev: number | null,
  end: number,
  messageCount: number,
  syncing: boolean,
  wasSyncing: boolean,
): number | null {
  if (syncing || wasSyncing) return end
  if (prev === null && messageCount > 0) return end
  return prev
}

/**
 * Pure decision for where a newly opened conversation lands.
 *
 * - `bottom`: scrollTop showing the thread's real end above the composer.
 * - `rawTarget`: scrollTop placing the latest message's top right below the
 *   header (without StickyPrompt clearance), or `null` to force bottom landing.
 * - `bar`: StickyPrompt height reserved only when unpinned with a user prompt
 *   above (otherwise StickyPrompt stays hidden and needs no room).
 */
export function resolveLanding({
  bottom,
  rawTarget,
  bar = BAR,
  hasUserAbove = false,
  nearBottom = NEAR_BOTTOM,
}: {
  bottom: number
  rawTarget: number | null
  bar?: number
  hasUserAbove?: boolean
  nearBottom?: number
}): LandingDecision {
  const floor = Math.max(0, bottom)
  if (rawTarget === null) return { top: floor, pinned: true, mode: 'bottom' }
  const clamped = Math.max(0, rawTarget)
  // Fits on screen when pinned to bottom: keep standard bottom landing.
  if (clamped >= floor - 4) {
    return { top: floor, pinned: true, mode: 'bottom' }
  }
  const unpinned = floor - clamped >= nearBottom
  const top = unpinned && hasUserAbove ? Math.max(0, clamped - bar) : clamped
  return {
    top,
    pinned: !unpinned,
    mode: 'latest-top',
  }
}

/**
 * Measure the live thread DOM and decide where initial landing should scroll.
 * Must run synchronously before paint (useLayoutEffect or ResizeObserver) when
 * moving `scrollTop` so no intermediate bottom frame is ever painted.
 */
export function measureLanding(
  el: HTMLElement,
  endEl: HTMLElement | null,
  bottom: number,
  preferLatestTop: boolean,
): LandingDecision & { bottom: number } {
  const floor = Math.max(0, bottom)
  if (!preferLatestTop) {
    return { top: floor, pinned: true, mode: 'bottom', bottom: floor }
  }
  const container = endEl?.parentElement
  const msgs = container?.querySelectorAll<HTMLElement>('[data-msg]')
  const last = msgs && msgs.length > 0 ? msgs.item(msgs.length - 1) : null
  if (!last || floor <= 0) {
    return { top: floor, pinned: true, mode: 'bottom', bottom: floor }
  }
  // Move to `floor` first (before paint) so sticky `[data-chat-top]` sits right
  // under the session header regardless of where `scrollTop` started.
  if (el.scrollTop !== floor) el.scrollTop = floor
  const anchor = el.querySelector<HTMLElement>('[data-chat-top]')
  const headerLine =
    (anchor
      ? anchor.getBoundingClientRect().top
      : el.getBoundingClientRect().top) + 8
  const rawTarget = el.scrollTop + last.getBoundingClientRect().top - headerLine
  const hasUserAbove =
    last.dataset.role !== 'user' &&
    Boolean(container?.querySelector('[data-user-at]'))
  return {
    ...resolveLanding({ bottom: floor, rawTarget, bar: BAR, hasUserAbove }),
    bottom: floor,
  }
}

/**
 * Keyboard opening / closing: hold a pinned thread at the bottom every frame
 * until the browser is done resizing and scrolling.
 */
export function useHoldBottomOnResize({
  end,
  pinnedRef,
  landed,
  touching,
  holdUntil,
  holding,
  bottomOf,
  wide = false,
}: {
  end: React.RefObject<HTMLDivElement | null>
  pinnedRef: React.RefObject<boolean>
  landed: React.RefObject<boolean>
  touching: React.RefObject<boolean>
  holdUntil: React.RefObject<number>
  holding: React.RefObject<boolean>
  bottomOf: (el: HTMLElement) => number
  wide?: boolean
}) {
  useEffect(() => {
    const el = end.current?.closest<HTMLElement>('.overflow-y-auto') ?? null
    if (!el) return
    const hold = (ms: number, why: string) => {
      if (!pinnedRef.current || !landed.current) return
      holdUntil.current = Math.max(holdUntil.current, performance.now() + ms)
      if (holding.current) return
      holding.current = true
      trace('chat-hold', { why, ms })
      const frame = () => {
        if (performance.now() >= holdUntil.current || !pinnedRef.current) {
          holding.current = false
          return
        }
        if (!touching.current) el.scrollTop = bottomOf(el)
        requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    }
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof HTMLTextAreaElement) hold(1_000, event.type)
    }
    const onViewport = () => hold(500, 'viewport')
    el.addEventListener('focusin', onFocus)
    el.addEventListener('focusout', onFocus)
    window.visualViewport?.addEventListener('resize', onViewport)
    window.addEventListener('resize', onViewport)
    return () => {
      el.removeEventListener('focusin', onFocus)
      el.removeEventListener('focusout', onFocus)
      window.visualViewport?.removeEventListener('resize', onViewport)
      window.removeEventListener('resize', onViewport)
    }
  }, [end, pinnedRef, landed, touching, holdUntil, holding, bottomOf, wide])
}

/**
 * Loading earlier messages grows the page above the reader: capture the first
 * visible `[data-msg]` right before the prepended slice commits (not before
 * the network request starts, while the reader may still be scrolling), then
 * restore its viewport offset synchronously before paint. Falls back to
 * distance-from-bottom if the anchored node is gone.
 */
export function useKeepPlace(
  end: React.RefObject<HTMLDivElement | null>,
  start: number,
) {
  const anchor = useRef<{
    msg?: string
    top?: number
    fromBottom: number
  } | null>(null)
  useLayoutEffect(() => {
    const scroller = end.current?.closest<HTMLElement>('.overflow-y-auto')
    const saved = anchor.current
    if (!scroller || !saved) return
    anchor.current = null
    const correct = () => {
      const node = saved.msg
        ? scroller.querySelector<HTMLElement>(`[data-msg="${saved.msg}"]`)
        : null
      if (node && saved.top !== undefined) {
        const drift = node.getBoundingClientRect().top - saved.top
        if (Math.abs(drift) >= 0.5) scroller.scrollTop += drift
      } else {
        scroller.scrollTop = scroller.scrollHeight - saved.fromBottom
      }
    }
    // First pass moves the viewport back to the anchored message before paint;
    // a short multi-frame rAF settle absorbs Chromium's async
    // content-visibility:auto unskipping of the newly adjacent prepended items
    // above the anchor (which settles 1-2 frames after scrollTop changes).
    // Any user scroll input cancels the settle immediately.
    correct()
    let framesLeft = 6
    let frame = 0
    const cancel = () => {
      framesLeft = 0
      cancelAnimationFrame(frame)
    }
    const tick = () => {
      if (framesLeft <= 0) return
      framesLeft -= 1
      correct()
      if (framesLeft > 0) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    scroller.addEventListener('wheel', cancel, { passive: true, once: true })
    scroller.addEventListener('touchstart', cancel, {
      passive: true,
      once: true,
    })
    scroller.addEventListener('pointerdown', cancel, {
      passive: true,
      once: true,
    })
    return () => {
      cancel()
      scroller.removeEventListener('wheel', cancel)
      scroller.removeEventListener('touchstart', cancel)
      scroller.removeEventListener('pointerdown', cancel)
    }
  }, [start, end])
  return useCallback(() => {
    const scroller = end.current?.closest<HTMLElement>('.overflow-y-auto')
    if (!scroller) return
    const sr = scroller.getBoundingClientRect()
    const nodes = scroller.querySelectorAll<HTMLElement>('[data-msg]')
    let pick: HTMLElement | null = null
    for (const node of nodes) {
      if (node.getBoundingClientRect().bottom > sr.top + 4) {
        pick = node
        break
      }
    }
    if (!pick && nodes.length > 0) pick = nodes.item(0)
    anchor.current = {
      msg: pick?.dataset.msg,
      top: pick ? pick.getBoundingClientRect().top : undefined,
      fromBottom: scroller.scrollHeight - scroller.scrollTop,
    }
  }, [end])
}
