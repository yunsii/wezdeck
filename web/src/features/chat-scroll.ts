// Follow the conversation like a chat app: stay pinned to the newest message
// (including while a reply streams in and grows every frame) until the reader
// scrolls up themselves — only a finger, wheel or key counts, never our own
// scrolling — and pin again once they come back to the bottom. While unpinned
// the page offers a "jump to latest" button with the number of new messages.
// A finger dragging the history down (more than a tap's wobble) unpins at
// once, nothing auto-scrolls while a finger is on the screen, and while the
// keyboard opens or closes (composer focus / blur, viewport resize) a pinned
// thread is held on its newest message every frame, whatever order the
// browser resizes and scrolls in. Pin changes and holds go to the client
// trace (lib/client-trace.ts) so a phone can report what happened.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

import { trace } from '#/lib/client-trace'
import { useIsWidePhoneFirst } from '#/lib/use-media'
import { CATCH_UP_EVENT } from './chat-catchup'
import {
  NEAR_BOTTOM,
  measureLanding,
  useHoldBottomOnResize,
  useLatchedPreferLatestTop,
  useSettleOnCountChange,
} from './chat-landing'
import type { LandingTarget } from './chat-landing'
import { BAR } from './chat-sticky'

export { useKeepPlace } from './chat-landing'

/** a panel's open / close animation (motion-collapse) and a margin */
const TOGGLE_HOLD_MS = 450
/** finger travel that counts as a drag, not a tap */
const DRAG = 8

/** room a closed panel borrowed under the thread (the `end` sentinel) */
const borrowed = (spacer: HTMLElement | null) =>
  parseFloat(spacer?.style.height ?? '') || 0

/** the scroll position of the thread's real end: the borrowed room is not content */
const endTop = (el: HTMLElement, spacer: HTMLElement | null) =>
  el.scrollHeight - borrowed(spacer) - el.clientHeight

/**
 * Keep only the borrowed room still on screen: what scrolled off, or what
 * new content now fills, goes — nothing that shows moves. Returns what is
 * left (0: the thread reaches the bottom of the screen by itself).
 */
function fitSpacer(el: HTMLElement, spacer: HTMLElement | null) {
  const lent = borrowed(spacer)
  if (!spacer || !lent) return 0
  const need = Math.max(
    0,
    Math.min(lent, el.scrollTop + el.clientHeight - (el.scrollHeight - lent)),
  )
  if (need < 0.5) spacer.style.removeProperty('height')
  else if (Math.abs(need - lent) >= 0.5) spacer.style.height = `${need}px`
  return need < 0.5 ? 0 : need
}

/**
 * After a close: keep at most half a screen of the room it gave up. More
 * glides away (the thread moves down into it), never so far that the tapped
 * row leaves the screen. Then `settled` decides about the bottom.
 */
function trimBorrowed(
  el: HTMLElement,
  trigger: HTMLElement,
  spacer: HTMLElement | null,
  settled: () => void,
) {
  const lent = fitSpacer(el, spacer)
  const box = el.getBoundingClientRect()
  const room = box.bottom - 8 - trigger.getBoundingClientRect().bottom
  const move = Math.max(0, Math.min(lent - el.clientHeight / 2, room))
  if (move < 1) return settled()
  const from = el.scrollTop
  const begin = performance.now()
  const frame = (now: number) => {
    const p = Math.min(1, (now - begin) / 260)
    el.scrollTop = from - move * (1 - (1 - p) ** 3)
    if (p < 1) requestAnimationFrame(frame)
    else {
      fitSpacer(el, spacer)
      settled()
    }
  }
  requestAnimationFrame(frame)
}

/**
 * Keep a tapped panel trigger at its screen position through the panel's
 * open / close animation; when closing leaves no room below to scroll to,
 * grow `spacer` (the thread's end sentinel) by what is missing.
 */
function holdRow(
  el: HTMLElement,
  trigger: HTMLElement,
  spacer: HTMLElement | null,
) {
  const top = trigger.getBoundingClientRect().top
  const until = performance.now() + TOGGLE_HOLD_MS
  const keep = () => {
    const drift = trigger.getBoundingClientRect().top - top
    if (Math.abs(drift) >= 0.5) {
      const short = el.scrollTop + drift - (el.scrollHeight - el.clientHeight)
      if (short > 0 && spacer)
        spacer.style.height = `${borrowed(spacer) + short}px`
      el.scrollTop += drift
    }
    if (performance.now() < until) requestAnimationFrame(keep)
  }
  requestAnimationFrame(keep)
}

/**
 * A tool run's panel was tapped open or closed: hold its row on screen (with
 * the browser's scroll anchoring off meanwhile).
 * Closing lends the room the panel gives up before it shrinks (so the
 * browser never pulls the thread down to a shorter end); a run whose row was
 * scrolled past closes onto its row instead.
 */
function panelToggled(
  el: HTMLElement,
  trigger: HTMLElement,
  spacer: HTMLElement | null,
  settled: () => void,
) {
  // the browser's scroll anchoring re-picks an anchor below the panel and
  // shifts the page as it changes height (measured: no script wrote
  // scrollTop, yet the row moved): off for the animation, our hold does it
  el.style.overflowAnchor = 'none'
  setTimeout(
    () => el.style.removeProperty('overflow-anchor'),
    TOGGLE_HOLD_MS + 50,
  )
  const closing = trigger.getAttribute('aria-expanded') === 'true'
  // closing: lend the room the panel gives up before it shrinks, so the
  // browser never pulls the thread down to a shorter end
  const panel = document.getElementById(
    trigger.getAttribute('aria-controls') ?? '',
  )
  if (closing && panel && spacer)
    spacer.style.height = `${borrowed(spacer) + panel.getBoundingClientRect().height}px`
  // a run scrolled past (its row above the screen) closes onto its row
  const above =
    trigger.getBoundingClientRect().top < el.getBoundingClientRect().top
  if (closing && above)
    setTimeout(() => {
      el.scrollTop +=
        trigger.getBoundingClientRect().top - el.getBoundingClientRect().top - 8
    }, TOGGLE_HOLD_MS)
  else {
    holdRow(el, trigger, spacer)
    // closing near the bottom: the lent room stays up to half a screen
    if (closing)
      setTimeout(
        () => trimBorrowed(el, trigger, spacer, settled),
        TOGGLE_HOLD_MS,
      )
  }
  // what the row actually did, for `wezdeck-wsl diag`: headless touch
  // emulation moved it where mouse / scripted clicks did not (2026-11-24),
  // so a phone's own numbers settle it
  const before = {
    row: Math.round(trigger.getBoundingClientRect().top),
    scrollTop: Math.round(el.scrollTop),
  }
  setTimeout(() => {
    trace('panel-toggle', {
      action: closing ? (above ? 'close-above' : 'close') : 'open',
      drift: Math.round(trigger.getBoundingClientRect().top) - before.row,
      scrollTop: [before.scrollTop, Math.round(el.scrollTop)],
      borrowed: Math.round(borrowed(spacer)),
    })
  }, TOGGLE_HOLD_MS + 100)
}

/**
 * A backlog was shown at once (chat-catchup.ts): a reader following the
 * bottom stops at the first message they have not seen, not past it, and
 * leaves the bottom — the jump button then counts what is below.
 */
function useStopAtUnread(
  end: React.RefObject<HTMLDivElement | null>,
  pinnedRef: React.RefObject<boolean>,
  pin: (value: boolean) => void,
  wide: boolean,
) {
  useEffect(() => {
    const el = end.current?.closest<HTMLElement>('.overflow-y-auto')
    if (!el) return
    const onCatchUp = (event: Event) => {
      if (!pinnedRef.current || !(event.target instanceof HTMLElement)) return
      pin(false)
      // below the header and the sticky prompt that will show over it
      const anchor = el.querySelector('[data-chat-top]')
      const line = anchor
        ? anchor.getBoundingClientRect().top + BAR + 8
        : el.getBoundingClientRect().top + 8
      el.scrollTop += event.target.getBoundingClientRect().top - line
      trace('chat-catch-up', {
        from: (event as CustomEvent<{ from: number }>).detail.from,
        scrollTop: Math.round(el.scrollTop),
      })
    }
    el.addEventListener(CATCH_UP_EVENT, onCatchUp)
    return () => el.removeEventListener(CATCH_UP_EVENT, onCatchUp)
  }, [end, pinnedRef, pin, wide])
}

/** a streaming reply easing its height (chat-grow.tsx) */
const easing = (el: HTMLElement) => el.querySelector('[data-growing]') !== null

/** after a conversation opens, growth jumps instead of gliding for this long
 * (extended while it keeps growing) */
const LANDING_MS = 1500

/**
 * Land at the bottom before the first paint: a wide-split switch keeps the
 * page scroller, so the new thread showed at the old offset for a frame (a
 * content jump, the sticky prompt flashing). The rAF landing in
 * useChatScroll still settles late layout (images, fonts). Returns the end
 * of the landing window: until then the thread is still settling (markdown
 * laid out, earlier items added by the progressive render) and growth
 * jumps to the bottom — gliding there played a scroll animation on every
 * switch (measured: 1910 → 2694 over ~150 ms).
 */
function useLandBeforePaint(
  end: React.RefObject<HTMLDivElement | null>,
  count: number,
  landed: React.RefObject<boolean>,
  userInteracted: React.RefObject<boolean>,
  syncing: boolean,
  applyLanding: (el: HTMLElement) => void,
) {
  const landingUntil = useRef(0)
  const wasSyncing = useRef(syncing)
  useLayoutEffect(() => {
    // Re-land once when the initial post-mount fetch finishes (e.g. cached
    // snapshot updated to newly completed `done` messages), unless the reader
    // already interacted.
    const justSynced = wasSyncing.current && !syncing
    wasSyncing.current = syncing
    if (!count || userInteracted.current) return
    if (landed.current && !syncing && !justSynced) return
    const el = end.current?.closest<HTMLElement>('.overflow-y-auto')
    if (el) applyLanding(el)
    landingUntil.current = performance.now() + LANDING_MS
  }, [count, end, landed, userInteracted, syncing, applyLanding])
  return landingUntil
}

/** still settling after it opened? Growth then keeps the window open a while */
function grewWhileLanding(landing: React.RefObject<number>) {
  const now = performance.now()
  if (now >= landing.current) return false
  landing.current = Math.max(landing.current, now + 600)
  return true
}

/**
 * A streaming reply grows without changing the count, and the keyboard shrinks
 * the scroller: either way a pinned thread follows its newest line, while
 * landing keeps the chosen landing target in place before paint.
 */
function useFollowGrowth({
  end,
  pinnedRef,
  landed,
  landing,
  touching,
  holding,
  userInteracted,
  applyLanding,
  wide,
}: {
  end: React.RefObject<HTMLDivElement | null>
  pinnedRef: React.RefObject<boolean>
  landed: React.RefObject<boolean>
  landing: React.RefObject<number>
  touching: React.RefObject<boolean>
  holding: React.RefObject<boolean>
  userInteracted: React.RefObject<boolean>
  applyLanding: (el: HTMLElement) => void
  wide: boolean
}) {
  useEffect(() => {
    const el = end.current?.closest<HTMLElement>('.overflow-y-auto') ?? null
    const content = el ? [...el.children] : []
    if (!el || !content.length || typeof ResizeObserver === 'undefined') return
    const live = () => landed.current || performance.now() < landing.current
    const following = () => pinnedRef.current && live() && !touching.current
    const jumpDown = () => {
      if (following() && !fitSpacer(el, end.current))
        el.scrollTop = endTop(el, end.current)
    }
    let glide = 0
    const glideDown = () => {
      if (glide || !following()) return
      const frame = () => {
        const left = endTop(el, end.current) - el.scrollTop
        if (!following() || left <= 0.5 || holding.current) {
          glide = 0
          return
        }
        el.scrollTop += Math.max(1, left * 0.2)
        glide = requestAnimationFrame(frame)
      }
      glide = requestAnimationFrame(frame)
    }
    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches
    const observer = new ResizeObserver((entries) => {
      fitSpacer(el, end.current)
      if (
        !userInteracted.current &&
        !touching.current &&
        grewWhileLanding(landing)
      ) {
        if (!fitSpacer(el, end.current)) applyLanding(el)
        return
      }
      const now = !smooth
      if (now || easing(el) || entries.some((e) => e.target === el)) jumpDown()
      else glideDown()
    })
    content.forEach((child) => observer.observe(child))
    observer.observe(el)
    const viewport = window.visualViewport
    viewport?.addEventListener('resize', jumpDown)
    return () => {
      cancelAnimationFrame(glide)
      observer.disconnect()
      viewport?.removeEventListener('resize', jumpDown)
    }
  }, [
    end,
    pinnedRef,
    landed,
    landing,
    touching,
    holding,
    userInteracted,
    applyLanding,
    wide,
  ])
}

export function useChatScroll(
  end: React.RefObject<HTMLDivElement | null>,
  count: number,
  landingTarget: boolean | LandingTarget = false,
  syncing = false,
) {
  const wide = useIsWidePhoneFirst()
  const [pinned, setPinned] = useState(true)
  const pinnedRef = useRef(true)
  const landed = useRef(false)
  const userInteracted = useRef(false)
  const preferRef = useLatchedPreferLatestTop(landingTarget)
  const lastLandMode = useRef<string | null>(null)
  const userUntil = useRef(0)
  const touching = useRef(false)
  const holdUntil = useRef(0)
  const holding = useRef(false)
  const [unread, setUnread] = useState(0)
  const pin = useCallback((value: boolean) => {
    if (pinnedRef.current !== value) trace('chat-pin', { pinned: value })
    pinnedRef.current = value
    setPinned(value)
    if (value) setUnread(0)
  }, [])
  const applyLanding = useCallback(
    (el: HTMLElement) => {
      const decision = measureLanding(
        el,
        end.current,
        endTop(el, end.current),
        preferRef.current,
      )
      el.scrollTop = decision.top
      if (pinnedRef.current !== decision.pinned) {
        pinnedRef.current = decision.pinned
        setPinned(decision.pinned)
        if (decision.pinned) setUnread(0)
      }
      if (lastLandMode.current !== decision.mode) {
        lastLandMode.current = decision.mode
        trace('chat-land', {
          mode: decision.mode,
          top: Math.round(decision.top),
          bottom: Math.round(decision.bottom),
        })
      }
    },
    [end],
  )
  const toBottom = useCallback(
    (smooth: boolean) => {
      const el = end.current?.closest<HTMLElement>('.overflow-y-auto')
      if (!el) return
      el.scrollTo({
        top: endTop(el, end.current),
        behavior: smooth ? 'smooth' : 'auto',
      })
    },
    [end],
  )

  useStopAtUnread(end, pinnedRef, pin, wide)

  // reader intent: only real input may unpin
  useEffect(() => {
    const el = end.current?.closest<HTMLElement>('.overflow-y-auto') ?? null
    if (!el) return
    const intent = () => {
      userInteracted.current = true
      landed.current = true
      userUntil.current = performance.now() + 400
      holdUntil.current = 0 // the reader takes over: stop holding the bottom
    }
    // a finger dragging the history down keeps it unpinned until it lifts;
    // re-pinning from scroll events mid-drag made the state (and the jump
    // button) flap every frame near the bottom
    let readingBack = false
    // while a tapped row is held (holdRow), our own scroll corrections and
    // the borrowed spacer must not count as "back at the bottom": re-pinning
    // cleared the spacer mid-close and the thread dropped again
    let toggleUntil = 0
    const nearBottom = () =>
      endTop(el, end.current) - el.scrollTop < NEAR_BOTTOM
    const onScroll = () => {
      // the borrowed room keeps only what is still on screen
      if (performance.now() > toggleUntil) fitSpacer(el, end.current)
      if (nearBottom()) {
        if (
          !pinnedRef.current &&
          !readingBack &&
          performance.now() > toggleUntil
        )
          pin(true)
      } else if (
        performance.now() < userUntil.current &&
        performance.now() > holdUntil.current &&
        pinnedRef.current
      ) {
        pin(false)
      }
    }
    const onKey = (event: KeyboardEvent) => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) intent()
    }
    let startY = 0
    const onTouchStart = (event: TouchEvent) => {
      touching.current = true
      startY = event.touches.item(0)?.clientY ?? 0
    }
    const onTouchMove = (event: TouchEvent) => {
      const moved = (event.touches.item(0)?.clientY ?? startY) - startY
      if (Math.abs(moved) < DRAG) return // a tap's wobble is no intent
      intent()
      // finger moving down = reading back: leave the bottom right away
      if (moved > 0) {
        readingBack = true
        if (pinnedRef.current) pin(false)
      }
    }
    const onTouchEnd = () => {
      touching.current = false
      if (readingBack && nearBottom()) pin(true)
      readingBack = false
    }
    // opening or closing a run of tool calls is reading: the tapped row
    // stays where it is. Leave the bottom first (pinned, the growth glided
    // the thread down), then hold the row's screen position every frame of
    // the panel's animation. Closing near the bottom has no room below — the
    // browser pulled the whole thread down to the new end — so a spacer under
    // the thread (the `end` sentinel) lends the missing room until the reader
    // is back at the bottom.
    const onToggle = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null
      const trigger = target?.closest<HTMLElement>('[aria-expanded]')
      // the thread's own panels only: holding a footer toggle (subagents)
      // scrolled the whole conversation and lent blank room on close
      if (!trigger || !end.current?.parentElement?.contains(trigger)) return
      intent()
      if (pinnedRef.current) pin(false)
      toggleUntil = performance.now() + TOGGLE_HOLD_MS + 450
      // closed with the thread's real end still on screen: that is the
      // bottom — stay pinned, no 回到最新
      panelToggled(el, trigger, end.current, () => {
        if (nearBottom() || el.scrollTop >= endTop(el, end.current)) pin(true)
      })
    }
    el.addEventListener('click', onToggle, true)
    el.addEventListener('wheel', intent, { passive: true })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('touchend', onTouchEnd, { passive: true })
    el.addEventListener('touchcancel', onTouchEnd, { passive: true })
    el.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('keydown', onKey)
    return () => {
      el.removeEventListener('click', onToggle, true)
      el.removeEventListener('wheel', intent)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
      el.removeEventListener('scroll', onScroll)
      window.removeEventListener('keydown', onKey)
    }
  }, [pin, end, wide])

  const landing = useLandBeforePaint(
    end,
    count,
    landed,
    userInteracted,
    syncing,
    applyLanding,
  )

  useSettleOnCountChange({
    end,
    count,
    syncing,
    landed,
    pinnedRef,
    touching,
    userInteracted,
    applyLanding,
    toBottom,
    setUnread,
  })

  useFollowGrowth({
    end,
    pinnedRef,
    landed,
    landing,
    touching,
    holding,
    userInteracted,
    applyLanding,
    wide,
  })
  const bottomOf = useCallback(
    (el: HTMLElement) => endTop(el, end.current),
    [end],
  )
  useHoldBottomOnResize({
    end,
    pinnedRef,
    landed,
    touching,
    holdUntil,
    holding,
    bottomOf,
    wide,
  })

  const jump = useCallback(() => {
    userInteracted.current = true
    landed.current = true
    pin(true)
    toBottom(!matchMedia('(prefers-reduced-motion: reduce)').matches)
  }, [pin, toBottom])

  return { pinned, unread, jump }
}
