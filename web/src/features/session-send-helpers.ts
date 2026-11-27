// Pure helpers for session writes (re-exported by session-send.ts).
import type { Pending } from './chat-thread'
import type { SentRecord } from './sent-history'

/**
 * Merge local optimistic bubbles (sending / just-sent) with host-persisted
 * unsettled outbox records returned on `session` polls. Deduplicates by
 * `client_op` (host wins once recorded), so pending and unconfirmed bubbles
 * survive page reloads and cross-device switches without flickering.
 */
export function mergeOutboxPending(
  local: Array<Pending>,
  hostOutbox?: Array<SentRecord>,
  dismissedIds?: ReadonlySet<string>,
): Array<Pending> {
  const visibleHost = dismissedIds?.size
    ? hostOutbox?.filter((rec) => !dismissedIds.has(rec.id))
    : hostOutbox
  if (!visibleHost?.length) return local
  const hostOps = new Set<string>()
  const hostItems: Array<Pending> = visibleHost.map((rec) => {
    if (rec.client_op) hostOps.add(rec.client_op)
    const state: Pending['state'] =
      rec.status === 'failed'
        ? 'failed'
        : rec.status === 'unconfirmed'
          ? 'lost'
          : 'queued'
    return {
      text: rec.text,
      attachments: rec.attachments ?? [],
      at: rec.created_at,
      after: rec.transcript_end_at_send,
      sentId: rec.id,
      clientOp: rec.client_op,
      error: rec.error,
      state,
    }
  })
  const extras = local.filter((item) => {
    if (item.clientOp && hostOps.has(item.clientOp)) return false
    if (
      !item.clientOp &&
      hostItems.some(
        (h) =>
          h.text.trim() === item.text.trim() &&
          Math.abs(h.at - item.at) < 5_000,
      )
    ) {
      return false
    }
    return true
  })
  return [...hostItems, ...extras].sort((a, b) => a.at - b.at)
}

/**
 * The host refuses a write right after input at the desk and says when to
 * try again ("… retry in 7s"): count down and resend instead of failing.
 */
export async function withDeskRetry<T>(
  attempt: () => Promise<T>,
  onWait: (seconds: number) => void,
  tries = 3,
  sleep = (ms: number) => new Promise((done) => setTimeout(done, ms)),
): Promise<T> {
  for (let round = 0; ; round++) {
    try {
      return await attempt()
    } catch (error) {
      const wait = /retry in (\d+)s/.exec((error as Error).message)
      if (!wait || round >= tries) throw error
      for (let left = Number(wait[1]); left > 0; left--) {
        onWait(left)
        await sleep(1_000)
      }
      onWait(0)
    }
  }
}

/**
 * "/new" for a slash command ("/new", "/compact focus on x"), else "" — a
 * path ("/home/me/x.png …") is a message
 */
export const commandOf = (text: string) =>
  /^\/[a-z][\w:-]*(?=\s|$)/i.exec(text.trim())?.[0] ?? ''
