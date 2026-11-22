// Follow the conversation like a chat app: stay pinned to the newest message
// (including while a reply streams in and grows every frame) until the reader
// scrolls up themselves — only a finger, wheel or key counts, never our own
// scrolling — and pin again once they come back to the bottom. While unpinned
// the page offers a "jump to latest" button with the number of new messages.
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
    el.addEventListener('wheel', intent, { passive: true })
    el.addEventListener('touchmove', intent, { passive: true })
    el.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('keydown', onKey)
    return () => {
      el.removeEventListener('wheel', intent)
      el.removeEventListener('touchmove', intent)
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

  // a streaming reply grows without changing the count: follow its height
  useEffect(() => {
    const el = scroller()
    const thread = end.current?.parentElement
    if (!el || !thread || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current && landed.current) el.scrollTop = el.scrollHeight
    })
    observer.observe(thread)
    return () => observer.disconnect()
  }, [end])

  const jump = useCallback(() => {
    pin(true)
    toBottom(!matchMedia('(prefers-reduced-motion: reduce)').matches)
  }, [pin, toBottom])

  return { pinned, unread, jump }
}
