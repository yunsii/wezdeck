// Reading back through a long session, the question the visible replies
// answer has long scrolled away. Pin it at the top: once the user's message
// that owns the content at the top of the screen is fully out of view, show
// it as one truncated line; tapping it glides back to that message (shown in
// full, briefly highlighted). Hidden near the bottom and while that message is
// on screen. The bar sits in a zero-height sticky box, so showing or hiding
// it never moves the thread.
import { useLingui } from '@lingui/react/macro'
import { CornerLeftUp } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { trace } from '#/lib/client-trace'
import { typedText } from './chat-thread'
import type { Message } from './chat-thread'

/** room the bar takes at the top (its height plus a little air) */
const BAR = 52
const NEAR_BOTTOM = 48

const reducedMotion = () =>
  matchMedia('(prefers-reduced-motion: reduce)').matches

export function StickyPrompt({
  end,
  messages,
  start,
}: {
  end: React.RefObject<HTMLDivElement | null>
  messages: Array<Message>
  /** absolute index of messages[0] */
  start: number
}) {
  const { t } = useLingui()
  const [owner, setOwner] = useState<number | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const scroller = () =>
    end.current?.closest<HTMLElement>('.overflow-y-auto') ?? null

  useEffect(() => {
    const el = scroller()
    if (!el) return
    let frame = 0
    const measure = () => {
      frame = 0
      if (el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM) {
        setOwner(null)
        return
      }
      const line = (box.current?.getBoundingClientRect().top ?? 0) + BAR
      let found: HTMLElement | null = null
      for (const node of el.querySelectorAll<HTMLElement>('[data-user-at]')) {
        if (node.getBoundingClientRect().top < line) found = node
        else break
      }
      const hidden = found && found.getBoundingClientRect().bottom <= line
      setOwner(hidden ? Number(found?.dataset.userAt) : null)
    }
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => {
      el.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(frame)
    }
    // re-measure when the thread changes under the reader
  }, [end, messages.length, start])

  const message = owner === null ? undefined : messages[owner - start]
  const text = message ? typedText(message.text).replace(/\s+/g, ' ') : ''

  const jump = () => {
    const el = scroller()
    const node = el?.querySelector<HTMLElement>(`[data-user-at="${owner}"]`)
    if (!el || !node) return
    const pinTop = box.current?.getBoundingClientRect().top ?? 0
    el.scrollTo({
      top: el.scrollTop + node.getBoundingClientRect().top - pinTop - 12,
      behavior: reducedMotion() ? 'auto' : 'smooth',
    })
    node.classList.remove('chat-flash')
    void node.offsetWidth // restart the highlight if it is still running
    node.classList.add('chat-flash')
    setTimeout(() => node.classList.remove('chat-flash'), 1_400)
    trace('chat-jump-prompt', { at: owner })
  }

  return (
    <div
      ref={box}
      className="sticky top-[calc(env(safe-area-inset-top)+var(--session-head,0px))] z-20 -mb-2 h-0"
    >
      {text ? (
        <button
          type="button"
          data-testid="sticky-prompt"
          onClick={jump}
          aria-label={t`Jump to your message: ${text}`}
          className="chat-in absolute inset-x-0 top-1 flex h-10 items-center gap-2 rounded-[14px] border border-brand-edge bg-brand-deck/95 px-3 text-left text-[13.5px] text-brand-text shadow-[0_8px_20px_-14px_rgb(0_0_0/0.35)] backdrop-blur"
        >
          <CornerLeftUp
            size={14}
            aria-hidden
            className="shrink-0 text-brand-label"
          />
          <span className="min-w-0 flex-1 truncate">{text}</span>
        </button>
      ) : null}
    </div>
  )
}
