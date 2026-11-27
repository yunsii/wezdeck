// Reading back through a long session, the question the visible replies
// answer has long scrolled away. Pin it at the top: once the user's message
// that owns the content at the top of the screen is fully out of view, show
// it as one truncated line; tapping it glides back to that message (shown in
// full, briefly highlighted). Hidden near the bottom and while that message is
// on screen. The bar sits in a zero-height sticky box, so showing or hiding
// it never moves the thread.
import { useLingui } from '@lingui/react/macro'
import { CornerLeftUp } from 'lucide-react'
import { AnimatePresence, m } from 'motion/react'
import { useEffect, useRef, useState } from 'react'

import { trace } from '#/lib/client-trace'
import { dropIn } from '#/lib/motion'
import { useIsWidePhoneFirst } from '#/lib/use-media'
import { typedText } from './chat-attachments'
import type { Message } from './chat-thread'
import { Button } from '#/components/ui/button'

/** room the bar takes at the top (its height plus a little air) */
/** the sticky prompt's height (also the room chat-scroll leaves above a jump) */
export const BAR = 52
const NEAR_BOTTOM = 48

const reducedMotion = () =>
  matchMedia('(prefers-reduced-motion: reduce)').matches

export function StickyPrompt({
  end,
  messages,
  start,
  following,
}: {
  end: React.RefObject<HTMLDivElement | null>
  messages: Array<Message>
  /** absolute index of messages[0] */
  start: number
  /**
   * the thread is pinned to its bottom (chat-scroll): no bar. Geometry alone
   * flashed it — content landing under a pinned thread (a session switch,
   * a streaming reply) puts the bottom > NEAR_BOTTOM away for the few frames
   * the glide takes to catch up.
   */
  following: boolean
}) {
  const { t } = useLingui()
  const [owner, setOwner] = useState<number | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const wide = useIsWidePhoneFirst()
  const followingRef = useRef(following)
  followingRef.current = following
  const scroller = () =>
    end.current?.closest<HTMLElement>('.overflow-y-auto') ?? null

  useEffect(() => {
    const el = scroller()
    if (!el) return
    let frame = 0
    const measure = () => {
      frame = 0
      if (
        followingRef.current ||
        el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM
      ) {
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
    // re-measure when the thread changes, pin state flips, or wide scroller swaps
  }, [end, messages.length, start, following, wide])

  const message =
    owner === null || following ? undefined : messages[owner - start]
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
      // the thread's visible top under the header: chat-scroll aligns to it
      data-chat-top
      className="sticky top-[calc(env(safe-area-inset-top)+var(--session-head,0px))] z-20 -mb-2 h-0"
    >
      {/* in from above, out with a fade (lib/motion.ts): it used to pop;
          the leaving bar keeps its last text while it fades */}
      <AnimatePresence>
        {text ? (
          <m.div
            key="sticky"
            {...dropIn}
            className="absolute inset-x-0 top-0 pt-1"
          >
            {/* the 4 px between the header and the bar, on the page's own
                ground: the thread showed through it (a dark user bubble
                peeking under the header) */}
            <span
              aria-hidden
              className="absolute -inset-x-2.5 top-0 h-1 bg-brand-deck"
            />
            <Button
              variant="plain"
              type="button"
              data-testid="sticky-prompt"
              onClick={jump}
              aria-label={t`Jump to your message: ${text}`}
              // the user's own bubble, folded to one line (same fill, ink,
              // radius and size): it used to be a dark bordered strip that
              // read as a different thing from the message it points back to
              className="flex h-10 w-full items-center gap-2 rounded-xl bg-brand-text px-3.5 text-left text-body text-brand-deck shadow-[0_8px_20px_-12px_rgb(0_0_0/0.45)]"
            >
              <CornerLeftUp
                size={15}
                aria-hidden
                className="shrink-0 opacity-60"
              />
              <span className="min-w-0 flex-1 truncate">{text}</span>
            </Button>
          </m.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}
