// Optimistic & host-backed outbox bubble settlement against transcript user
// lines. Split out of chat-thread.tsx to keep the thread component under
// ESLint's max-lines budget.
import { endsWithNote } from './chat-attachments'
import { pendingKey } from './chat-pending'
import type { Pending } from './chat-pending'
import type { Message } from './chat-thread'

/**
 * Drop optimistic bubbles the transcript now shows: each user line after
 * the point a message was sent settles at most one bubble, so two identical
 * messages need two lines and an earlier identical one never counts. A
 * bubble the transcript never shows turns lost a minute after it was sent
 * once the agent is idle (never while it works: a long turn keeps the
 * queue). It used to vanish silently then, so a paste the TUI swallowed
 * (a half-typed draft at the desk, an open completion menu) looked
 * delivered; now it stays as 未送达 until resent or removed, and a later
 * transcript line still settles it.
 */
export const LOST_AFTER_MS = 60_000

export function settle(
  pending: Array<Pending>,
  messages: Array<Message>,
  start = 0,
  busy = false,
  now = Date.now(),
) {
  return settleMatches(pending, messages, start, busy, now).left
}

/**
 * Combine transcript indices matched by current pending bubbles with indices
 * matched by bubbles that were visible in the queue on the immediately
 * preceding frame (before host outbox reconciliation removed them).
 */
export function collectSettledIndices(
  currentTook: ReadonlySet<number>,
  prevShown: Array<Pending>,
  currentPending: Array<Pending>,
  messages: Array<Message>,
  start = 0,
  busy = false,
  now = Date.now(),
): Set<number> {
  const out = new Set(currentTook)
  if (!prevShown.length) return out
  const currentKeys = new Set(currentPending.map(pendingKey))
  const departed = prevShown.filter(
    (item) => !currentKeys.has(pendingKey(item)),
  )
  if (!departed.length) return out
  for (const idx of settleMatches(departed, messages, start, busy, now).took) {
    out.add(idx)
  }
  return out
}

/** settle(), plus the transcript index of each line that settled a bubble */
export function settleMatches(
  pending: Array<Pending>,
  messages: Array<Message>,
  start = 0,
  busy = false,
  now = Date.now(),
) {
  const users = messages
    .map((message, index) => ({ message, at: start + index }))
    .filter(({ message }) => message.role === 'user')
    .map(({ message, at }) => ({ text: message.text.trim(), at }))
  const used = new Set<number>()
  // the host appends an attachment note after a blank line; also tolerate a
  // terminal draft prefix merged with the pasted web message (mirrors host
  // remote_outbox.go outboxMatchesUserLine).
  const matches = (
    typed: string,
    attachments: Array<string> | undefined,
    text: string,
  ) => {
    if (
      typed
        ? text === typed || endsWithNote(text, typed)
        : endsWithNote(text, '')
    )
      return true
    return attachments?.length
      ? attachments.every((name) => text.includes(name)) &&
          (!typed || text.includes(typed))
      : typed.length >= 4 && text.includes(typed)
  }
  const left: Array<Pending> = []
  for (const item of pending) {
    if (
      item.state === 'failed' ||
      item.state === 'deferred' ||
      item.state === 'waiting_review'
    ) {
      left.push(item)
      continue
    }
    const typed = item.text.trim()
    const line = users.find(
      (user) =>
        !used.has(user.at) &&
        user.at >= (item.after ?? 0) &&
        matches(typed, item.attachments, user.text),
    )
    if (line) {
      used.add(line.at)
      continue
    }
    if (item.state === 'lost') {
      left.push(item)
      continue
    }
    const browserSentAt = item.sentId ? item.browserSentAt : item.at
    const waiting = item.state === 'sending' || busy
    left.push(
      waiting ||
        browserSentAt === undefined ||
        now - browserSentAt < LOST_AFTER_MS
        ? item
        : { ...item, state: 'lost' },
    )
  }
  return { left, took: used }
}
