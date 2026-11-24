// Catching up on a backlog (2026-11-24). Replies that arrive while the page
// watches unfold at reading pace, one after another (chat-thread.tsx). When
// many arrive at once — the page was in the background or the phone locked,
// and the first poll on return brings them all — replaying each would keep
// the newest out of sight for tens of seconds. More than BACKLOG replies
// behind: everything before the newest reply shows at once, still, and only
// that reply unfolds; a reader at the bottom is taken to the first message
// they have not seen (useChatScroll listens for CATCH_UP_EVENT).
import { useLayoutEffect, useRef } from 'react'

import type { Item } from './chat-thread'

/** replies waiting before the thread stops replaying them one by one */
export const BACKLOG = 2

/** fired on the first skipped message's element; bubbles to the scroller */
export const CATCH_UP_EVENT = 'chat-catch-up'

/**
 * Where the reveal cursor goes: unchanged with ≤ BACKLOG replies waiting,
 * else onto the newest waiting reply (everything before it is shown).
 */
export function catchUp(items: Array<Item>, start: number, cursor: number) {
  const waiting = items.filter(
    (item) =>
      start + item.index >= cursor &&
      item.kind === 'message' &&
      item.message.role === 'assistant',
  )
  const newest = waiting.at(-1)
  if (waiting.length <= BACKLOG || !newest) return cursor
  return start + newest.index
}

/**
 * Once per catch-up, tell the scroller where unread starts: the first
 * skipped message (`from`, absolute index), drawn as `[data-msg=from]`.
 */
export function useCatchUpSignal(from: number | null) {
  const told = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (from === null || told.current === from) return
    told.current = from
    // the [data-msg] wrapper is display: contents (no box): use its child
    const wrapper = document.querySelector(`[data-msg="${from}"]`)
    const target = wrapper?.firstElementChild ?? null
    target?.dispatchEvent(
      new CustomEvent(CATCH_UP_EVENT, { bubbles: true, detail: { from } }),
    )
  }, [from])
}
