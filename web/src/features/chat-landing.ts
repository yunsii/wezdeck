// Initial landing geometry for a session conversation: normally a thread lands
// at its bottom, but when a session has just finished (`done`, with no waiting
// prompt card or pending send) and the newest message itself is taller than the
// visible viewport, landing strictly at the bottom clips its start off the top
// and leaves only its tail on screen. Land at the start of the latest message
// in that case — leaving room for StickyPrompt when unpinned — while later
// visits (`idle`) and live/waiting sessions land directly at the bottom.
import { useEffect, useLayoutEffect, useRef } from 'react'

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
}: {
  end: React.RefObject<HTMLDivElement | null>
  pinnedRef: React.RefObject<boolean>
  landed: React.RefObject<boolean>
  touching: React.RefObject<boolean>
  holdUntil: React.RefObject<number>
  holding: React.RefObject<boolean>
  bottomOf: (el: HTMLElement) => number
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
  }, [end, pinnedRef, landed, touching, holdUntil, holding, bottomOf])
}

/**
 * Loading earlier messages grows the page above the reader: remember the
 * distance from the bottom before, restore it once the older ones render.
 */
export function useKeepPlace(
  end: React.RefObject<HTMLDivElement | null>,
  start: number,
) {
  const fromBottom = useRef<number | null>(null)
  useLayoutEffect(() => {
    const scroller = end.current?.closest('.overflow-y-auto')
    if (!scroller || fromBottom.current === null) return
    scroller.scrollTop = scroller.scrollHeight - fromBottom.current
    fromBottom.current = null
  }, [start, end])
  return () => {
    const scroller = end.current?.closest('.overflow-y-auto')
    if (scroller)
      fromBottom.current = scroller.scrollHeight - scroller.scrollTop
  }
}
