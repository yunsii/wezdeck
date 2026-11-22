// Follow the conversation like a chat app: stay pinned to the newest message
// (including while a reply streams in and grows every frame) until the reader
// scrolls up themselves — only a finger, wheel or key counts, never our own
// scrolling — and pin again once they come back to the bottom. While unpinned
// the page offers a "jump to latest" button with the number of new messages.
// A finger dragging the history down unpins at once (no 48 px dead zone where
// a growing reply would yank the page back), nothing auto-scrolls while a
// finger is on the screen, and when the viewport shrinks (the keyboard opens)
// a pinned thread stays on its newest message.
import { useCallback, useEffect, useRef, useState } from 'react'

const NEAR_BOTTOM = 48

export function useChatScroll(
  end: React.RefObject<HTMLDivElement | null>,
  count: number,
) {
  const [pinned, setPinned] = useState(true)
  const pinnedRef = useRef(true)
  const landed = useRef(false)
  const userUntil = useRef(0)
  const touching = useRef(false)
  const [unread, setUnread] = useState(0)
  const seen = useRef(count)

  const scroller = () =>
    end.current?.closest<HTMLElement>('.overflow-y-auto') ?? null
  const pin = useCallback((value: boolean) => {
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
    }
    const onScroll = () => {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight
      if (gap < NEAR_BOTTOM) {
        if (!pinnedRef.current) pin(true)
      } else if (performance.now() < userUntil.current && pinnedRef.current) {
        pin(false)
      }
    }
    const onKey = (event: KeyboardEvent) => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) intent()
    }
    let touchY = 0
    const onTouchStart = (event: TouchEvent) => {
      touching.current = true
      touchY = event.touches.item(0)?.clientY ?? 0
    }
    const onTouchMove = (event: TouchEvent) => {
      intent()
      const y = event.touches.item(0)?.clientY ?? touchY
      // finger moving down = reading back: leave the bottom right away
      if (y - touchY > 4 && pinnedRef.current) pin(false)
      touchY = y
    }
    const onTouchEnd = () => {
      touching.current = false
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
    const thread = end.current?.parentElement
    if (!el || !thread || typeof ResizeObserver === 'undefined') return
    const follow = () => {
      if (pinnedRef.current && landed.current && !touching.current)
        el.scrollTop = el.scrollHeight
    }
    const observer = new ResizeObserver(follow)
    observer.observe(thread)
    observer.observe(el)
    const viewport = window.visualViewport
    viewport?.addEventListener('resize', follow)
    return () => {
      observer.disconnect()
      viewport?.removeEventListener('resize', follow)
    }
  }, [end])

  const jump = useCallback(() => {
    pin(true)
    toBottom(!matchMedia('(prefers-reduced-motion: reduce)').matches)
  }, [pin, toBottom])

  return { pinned, unread, jump }
}
