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
import { useCallback, useEffect, useRef, useState } from 'react'

import { trace } from '#/lib/client-trace'

/** a panel's open / close animation (motion-collapse) and a margin */
const TOGGLE_HOLD_MS = 450
const NEAR_BOTTOM = 48
/** finger travel that counts as a drag, not a tap */
const DRAG = 8

/** room a closed panel borrowed under the thread (the `end` sentinel) */
const borrowed = (spacer: HTMLElement | null) =>
  parseFloat(spacer?.style.height ?? '') || 0

/** the scroll position of the thread's real end: the borrowed room is not content */
const endTop = (el: HTMLElement, spacer: HTMLElement | null) =>
  el.scrollHeight - borrowed(spacer) - el.clientHeight

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
  else holdRow(el, trigger, spacer)
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

export function useChatScroll(
  end: React.RefObject<HTMLDivElement | null>,
  count: number,
) {
  const [pinned, setPinned] = useState(true)
  const pinnedRef = useRef(true)
  const landed = useRef(false)
  const userUntil = useRef(0)
  const touching = useRef(false)
  const holdUntil = useRef(0)
  const holding = useRef(false)
  const [unread, setUnread] = useState(0)
  const seen = useRef(count)

  const scroller = () =>
    end.current?.closest<HTMLElement>('.overflow-y-auto') ?? null
  const pin = useCallback((value: boolean) => {
    if (pinnedRef.current !== value) trace('chat-pin', { pinned: value })
    pinnedRef.current = value
    setPinned(value)
    if (value) setUnread(0)
  }, [])
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

  // reader intent: only real input may unpin
  useEffect(() => {
    const el = scroller()
    if (!el) return
    const intent = () => {
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
    // the borrowed room goes once it is off screen: no longer reachable
    // by eye, dropping it cannot move what is shown
    const release = () => {
      const spacer = end.current
      if (borrowed(spacer) && el.scrollTop <= endTop(el, spacer) + 1)
        spacer?.style.removeProperty('height')
    }
    const onScroll = () => {
      if (performance.now() > toggleUntil) release()
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
      if (!trigger || !el.contains(trigger)) return
      intent()
      if (pinnedRef.current) pin(false)
      toggleUntil = performance.now() + TOGGLE_HOLD_MS + 150
      panelToggled(el, trigger, end.current)
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
  }, [pin, end])

  // first landing (after the router's scroll restoration) and new messages
  useEffect(() => {
    if (!count) return
    const added = count - seen.current
    seen.current = count
    if (!pinnedRef.current) {
      if (added > 0) setUnread((n) => n + added)
      return
    }
    const smooth =
      landed.current && !matchMedia('(prefers-reduced-motion: reduce)').matches
    const go = () => {
      if (touching.current) return
      toBottom(smooth)
      landed.current = true
    }
    const frame = requestAnimationFrame(() => requestAnimationFrame(go))
    const timer = setTimeout(go, 150)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
    }
  }, [count, toBottom])

  // a streaming reply grows without changing the count, and the keyboard
  // shrinks the scroller: either way a pinned thread follows its newest line
  useEffect(() => {
    const el = scroller()
    // the whole page content: the thread and the composer (which grows with
    // the toolbar, thumbnails or a multi-line draft)
    const thread = document.getElementById('console-main')
    if (!el || !thread || typeof ResizeObserver === 'undefined') return
    const following = () =>
      pinnedRef.current && landed.current && !touching.current
    const jumpDown = () => {
      if (following()) el.scrollTop = endTop(el, end.current)
    }
    // content growth (a reply writing itself line by line) glides: each frame
    // covers a fifth of what is left, so new lines push the thread up
    // smoothly instead of the page jumping a line at a time
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
      // the scroller itself resized (keyboard): be at the bottom right away
      if (!smooth || entries.some((entry) => entry.target === el)) jumpDown()
      else glideDown()
    })
    observer.observe(thread)
    observer.observe(el)
    const viewport = window.visualViewport
    viewport?.addEventListener('resize', jumpDown)
    return () => {
      cancelAnimationFrame(glide)
      observer.disconnect()
      viewport?.removeEventListener('resize', jumpDown)
    }
  }, [end])

  // keyboard opening / closing: hold a pinned thread at the bottom every
  // frame until the browser is done resizing and scrolling
  useEffect(() => {
    const el = scroller()
    if (!el) return
    const hold = (ms: number, why: string) => {
      if (!pinnedRef.current || !landed.current) return
      holdUntil.current = Math.max(holdUntil.current, performance.now() + ms)
      if (holding.current) return
      holding.current = true
      trace('chat-hold', { why, ms })
      const frame = () => {
        // check first: a reader who scrolled away this frame wins
        if (performance.now() >= holdUntil.current || !pinnedRef.current) {
          holding.current = false
          return
        }
        if (!touching.current) el.scrollTop = endTop(el, end.current)
        requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    }
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof HTMLTextAreaElement) hold(1_000, event.type)
    }
    const onViewport = () => {
      hold(500, 'viewport')
    }
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
  }, [])

  const jump = useCallback(() => {
    pin(true)
    toBottom(!matchMedia('(prefers-reduced-motion: reduce)').matches)
  }, [pin, toBottom])

  return { pinned, unread, jump }
}
