// Pure helpers for session writes (re-exported by session-send.ts).
import type { QueryClient } from '@tanstack/react-query'
import {
  acceptSessionOptimistic,
  applySessionOptimistic,
  promptFingerprint,
  rollbackSessionOptimistic,
} from '#/lib/optimistic-state'
import type { Pending } from './chat-thread'
import type { SentRecord } from './sent-history'
import type { Detail } from './session-detail-types'
import type { SessionsReply } from './session-delete-state'

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
  outboxReadStartedAt?: number,
): Array<Pending> {
  const visibleHost = dismissedIds?.size
    ? hostOutbox?.filter((rec) => !dismissedIds.has(rec.id))
    : hostOutbox
  // An empty snapshot can clear queued bubbles left by a restart only if its
  // request started after the write was acknowledged. A poll already in
  // flight can return a pre-send outbox even after the write reply arrives.
  if (hostOutbox?.length === 0)
    return local.filter(
      (item) =>
        item.state === 'sending' ||
        (item.acceptedAt !== undefined &&
          (outboxReadStartedAt ?? 0) <= item.acceptedAt),
    )
  if (!visibleHost?.length) return local
  const localTimes = new Map(
    local
      .filter((item) => item.clientOp)
      .map((item) => [item.clientOp, item.at]),
  )
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
      browserSentAt: rec.client_op ? localTimes.get(rec.client_op) : undefined,
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
      const wait =
        /^(?:someone typed at the desk \d+s ago; )?retry in (\d+)s$/.exec(
          (error as Error).message,
        )
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

export function followSessionReply(
  follow: (from: string, to: string) => void,
  target: string,
  reply: unknown,
) {
  if (
    reply &&
    typeof reply === 'object' &&
    'session_id' in reply &&
    typeof reply.session_id === 'string' &&
    reply.session_id !== target
  ) {
    follow(target, reply.session_id)
  }
}

export function buildSessionBaseline(
  snapshot: Detail | undefined,
  transcriptEnd: number,
  listTs?: number,
  promptKey?: string,
) {
  const ts = Math.max(snapshot?.ts ?? 0, listTs ?? 0) || undefined
  return {
    status: snapshot?.status,
    ts,
    waitingKind: snapshot?.waiting_kind,
    promptKey: promptKey ?? promptFingerprint(snapshot),
    transcriptEnd,
  }
}

export function currentSessionBaseline(
  client: QueryClient,
  id: string,
  snapshot: Detail | undefined,
  transcriptEnd: number,
  promptKey?: string,
) {
  const listTs = client
    .getQueryData<SessionsReply>(['remote', 'sessions'])
    ?.sessions.find((row) => row.id === id)?.ts
  return buildSessionBaseline(snapshot, transcriptEnd, listTs, promptKey)
}

export function createResolvePrompt({
  target,
  baseline,
  client,
  onError,
  resolvingRef,
  opts,
}: {
  target: string
  baseline: ReturnType<typeof buildSessionBaseline>
  client: QueryClient
  onError: (message: string) => void
  resolvingRef: { current: number }
  opts: {
    kind: 'prompt-submit' | 'prompt-cancel'
    promptKey: string
    execute: () => Promise<boolean>
  }
}): Promise<boolean> {
  const op_id = crypto.randomUUID()
  applySessionOptimistic({
    id: target,
    opId: op_id,
    kind: opts.kind,
    suppressedPromptKey: opts.promptKey,
    baseline,
  })
  onError('')
  resolvingRef.current += 1
  return Promise.resolve()
    .then(() => opts.execute())
    .then((ok) => {
      if (!ok) {
        rollbackSessionOptimistic(target, op_id, 'key-failed')
        return false
      }
      acceptSessionOptimistic(target, op_id)
      void client.invalidateQueries({ queryKey: ['remote', 'session', target] })
      void client.invalidateQueries({ queryKey: ['remote', 'sessions'] })
      return true
    })
    .catch((error: unknown) => {
      rollbackSessionOptimistic(target, op_id, (error as Error).message)
      onError((error as Error).message)
      return false
    })
    .finally(() => {
      resolvingRef.current = Math.max(0, resolvingRef.current - 1)
    })
}
