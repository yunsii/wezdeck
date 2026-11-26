// The conversation cache for the session page (one TanStack entry per
// session, persisted to IndexedDB). The page asks the host only for what it
// lacks (native/wezdeck-wsl/session_window.go) and merges by message index:
//   full    the last N messages — replaces what we had
//   since   from `start` on: new messages, plus a pending tool call that got
//           its result — keeps what we had before `start`
//   before  an earlier page — goes in front of what we had
// Everything else in the reply (status, screen, usage, subagents…) is the
// latest; an earlier page only adds messages.

type Indexed = {
  messages?: Array<unknown>
  start?: number
  span?: string
  messages_rev?: number
}

export const PAGE = 60
/** messages kept per session when the cache is written to disk */
export const DISK_KEEP = 300

/** what to ask for next: the tail we lack, or a first page */
export function pollArgs(id: string, have?: Indexed) {
  const n = have?.messages?.length ?? 0
  return n > 0
    ? {
        id,
        since: (have?.start ?? 0) + n,
        messages_rev: have?.messages_rev ?? 0,
      }
    : { id, limit: PAGE }
}

export function mergeReply<T extends Indexed>(
  have: T | undefined,
  reply: T,
): T {
  const had = have?.messages ?? []
  const hadStart = have?.start ?? 0
  const got = reply.messages ?? []
  const gotStart = reply.start ?? 0
  if (!have || had.length === 0) return reply
  if (reply.span === 'since') {
    // a gap (we are behind the reply's start) or a start before ours: start over
    if (gotStart < hadStart || gotStart > hadStart + had.length) return reply
    return {
      ...reply,
      start: hadStart,
      messages: [...had.slice(0, gotStart - hadStart), ...got],
    }
  }
  if (reply.span === 'before') {
    if (have.messages_rev !== reply.messages_rev) return have
    // only the part that ends where ours begins; the rest is not news
    const front = got.slice(0, Math.max(hadStart - gotStart, 0))
    if (gotStart + got.length < hadStart) return have // not contiguous
    return {
      ...have,
      start: hadStart - front.length,
      messages: [...front, ...had],
    }
  }
  return reply
}

/** a copy small enough for IndexedDB: the newest DISK_KEEP messages */
export function trimForDisk<T extends Indexed>(detail: T): T {
  const messages = detail.messages ?? []
  if (messages.length <= DISK_KEEP) return detail
  const cut = messages.length - DISK_KEEP
  return {
    ...detail,
    start: (detail.start ?? 0) + cut,
    messages: messages.slice(cut),
  }
}
