// The live thread grows smoothly: a streaming reply lays out a line at a
// time, a new run of tool calls adds its whole block at once (measured: the
// turn line dropped 128 px and glided back). The box around the thread's
// items eases its height toward theirs every frame — a quarter of what is
// left — and marks itself `data-growing` meanwhile; a pinned thread then
// holds its end each frame instead of gliding after it (chat-scroll.ts), so
// the turn line under it stays put while everything above moves up smoothly.
// Shrinking is immediate.
import { useLayoutEffect, useRef, useState } from 'react'

/**
 * The first screen does not ease: the conversation lays out its earlier
 * messages and markdown for a while after it opens (measured on a running
 * session: 38 easing frames 0.8–1.45 s in, the bottom clipped and revealed
 * like a scroll down). Growth snaps until then.
 */
const LANDING_MS = 1500

export function SmoothGrow({
  active,
  className,
  children,
}: {
  /** the session is live (working, or messages still being revealed) */
  active: boolean
  /** the items' own layout (the thread's grid and gap) */
  className?: string
  children: React.ReactNode
}) {
  const outer = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  const [armedAt] = useState(() => performance.now() + LANDING_MS)
  useLayoutEffect(() => {
    const box = outer.current
    const content = inner.current
    if (!active || !box || !content || typeof ResizeObserver === 'undefined')
      return
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let shown = content.getBoundingClientRect().height
    let frame = 0
    const release = () => {
      box.style.removeProperty('height')
      box.style.removeProperty('overflow-y')
      box.removeAttribute('data-growing')
    }
    const step = () => {
      const target = content.getBoundingClientRect().height
      const left = target - shown
      if (Math.abs(left) <= 0.5 || performance.now() < armedAt) {
        shown = target
        frame = 0
        box.style.height = `${shown}px`
        box.removeAttribute('data-growing')
        return
      }
      shown += left > 0 ? Math.max(0.5, left * 0.25) : left
      box.style.height = `${shown}px`
      box.setAttribute('data-growing', '')
      frame = requestAnimationFrame(step)
    }
    // clip the bottom only: a list's two-digit marker (11.) hangs left of
    // the box, and overflow: hidden cut its first digit down to a dot
    box.style.overflowY = 'clip'
    box.style.height = `${shown}px`
    const observer = new ResizeObserver(() => {
      if (!frame) frame = requestAnimationFrame(step)
    })
    observer.observe(content)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      release()
    }
  }, [active, armedAt])
  return (
    <div ref={outer} className="min-w-0">
      <div ref={inner} className={className}>
        {children}
      </div>
    </div>
  )
}
