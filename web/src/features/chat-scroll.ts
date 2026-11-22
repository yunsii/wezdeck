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

const NEAR_BOTTOM = 48
/** finger travel that counts as a drag, not a tap */
const DRAG = 8

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
        top: el.scrollHeight,
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
    const nearBottom = () =>
      el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM
    const onScroll = () => {
      if (nearBottom()) {
        if (!pinnedRef.current && !readingBack) pin(true)
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
    el.addEventListener('wheel', intent, { passive: true })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('touchend', onTouchEnd, { passive: true })
    el.addEventListener('touchcancel', onTouchEnd, { passive: true })
    el.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('keydown', onKey)
    return () => {
      el.removeEventListener('wheel', intent)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
      el.removeEventListener('scroll', onScroll)
      window.removeEventListener('keydown', onKey)
    }
  }, [pin])

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
      if (following()) el.scrollTop = el.scrollHeight
    }
    // content growth (a reply writing itself line by line) glides: each frame
    // covers a fifth of what is left, so new lines push the thread up
    // smoothly instead of the page jumping a line at a time
    let glide = 0
    const glideDown = () => {
      if (glide || !following()) return
      const frame = () => {
        const left = el.scrollHeight - el.clientHeight - el.scrollTop
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
        if (!touching.current) el.scrollTop = el.scrollHeight
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
