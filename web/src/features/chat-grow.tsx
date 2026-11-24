// A streaming reply's box grows smoothly: the text lays out a line at a time
// (each batch that wraps adds a whole line at once), so the box eases its
// height toward the text's every frame — a quarter of what is left — and
// marks itself `data-growing` meanwhile. A pinned thread then holds its end
// each frame instead of gliding after it (chat-scroll.ts), so the turn line
// under the reply stays put while the text above moves up smoothly.
import { useLayoutEffect, useRef } from 'react'

export function SmoothGrow({
  active,
  children,
}: {
  /** the reply is streaming (or its last batch settling) */
  active: boolean
  children: React.ReactNode
}) {
  const outer = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
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
      if (Math.abs(left) <= 0.5) {
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
  }, [active])
  return (
    <div ref={outer} className="min-w-0">
      <div ref={inner}>{children}</div>
    </div>
  )
}
