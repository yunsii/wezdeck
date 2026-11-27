// Writes from the session page: messages (with attachments) and confirmation
// keys, the queue of sent-but-not-yet-in-the-transcript bubbles, and the
// countdown when the host asks to wait for the desk to go quiet.
import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState, useSyncExternalStore } from 'react'
import { toast } from 'sonner'

import { hostWrite } from '#/lib/runtime-client'
import { trace } from '#/lib/client-trace'

import type { Pending } from './chat-thread'
import type { Outgoing } from './session-composer'
import type { SentRecord } from './sent-history'
import { useNavigateToSession } from './session-follow'

export { useFollowReplacement } from './session-follow'

/**
 * Merge local optimistic bubbles (sending / just-sent) with host-persisted
 * unsettled outbox records returned on `session` polls. Deduplicates by
 * `client_op` (host wins once recorded), so pending and unconfirmed bubbles
 * survive page reloads and cross-device switches without flickering.
 */
export function mergeOutboxPending(
  local: Array<Pending>,
  hostOutbox?: Array<SentRecord>,
): Array<Pending> {
  if (!hostOutbox?.length) return local
  const hostOps = new Set<string>()
  const hostItems: Array<Pending> = hostOutbox.map((rec) => {
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
    // Fallback dedup when a host record lacks client_op (e.g. session_new)
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

type WriteState = { sending: boolean; error: string; retryIn: number }
const IDLE: WriteState = { sending: false, error: '', retryIn: 0 }
const NONE: Array<Pending> = []

/**
 * Sent messages not in the transcript yet, per session, for the page's life
 * (not the component's): the session page remounts on every switch (the
 * split keys it by id, a phone pushes it), and a message the host had queued
 * — not written to the transcript until the agent takes it — vanished from
 * the web console after switching away and back (2026-11-24).
 */
const pendingStore = new Map<string, Array<Pending>>()
const pendingListeners = new Set<() => void>()
const PENDING_KEEP_MS = 6 * 60 * 60_000

function updatePending(
  target: string,
  next: (list: Array<Pending>) => Array<Pending>,
) {
  const now = Date.now()
  // an old one the transcript never matched (a refused or lost send) goes
  const list = next(pendingStore.get(target) ?? NONE).filter(
    (item) => now - item.at < PENDING_KEEP_MS,
  )
  if (list.length) pendingStore.set(target, list)
  else pendingStore.delete(target)
  for (const listener of pendingListeners) listener()
}

/**
 * Seed a queued bubble for a host-side paste the page did not send itself
 * (session handoff's continuation brief). settle() drops it once the
 * transcript shows the same text.
 */
export function seedQueuedPending(
  id: string,
  text: string,
  opts?: { note?: string },
) {
  const trimmed = text.trim()
  if (!id || !trimmed) return
  const at = Date.now()
  updatePending(id, (list) => [
    ...list,
    {
      text: trimmed,
      note: opts?.note,
      attachments: [],
      at,
      after: 0,
      state: 'queued',
    },
  ])
}

export function transferPending(from: string, to: string) {
  if (!from || !to || from === to) return
  const items = pendingStore.get(from)
  if (!items?.length) return
  pendingStore.delete(from)
  const existing = pendingStore.get(to) ?? NONE
  const moved = items.map((item) => ({ ...item, after: 0 }))
  pendingStore.set(to, [...existing, ...moved])
  for (const listener of pendingListeners) listener()
}

/** Test helper: inspect queued bubbles for one session id. */
export function getPendingForTest(id: string): ReadonlyArray<Pending> {
  return pendingStore.get(id) ?? NONE
}

function usePending(id: string) {
  return useSyncExternalStore(
    (listener) => {
      pendingListeners.add(listener)
      return () => pendingListeners.delete(listener)
    },
    () => pendingStore.get(id) ?? NONE,
    () => NONE,
  )
}

/**
 * Per session, not per page: queued bubbles (above, page-wide), the sending
 * state, an error or a countdown are keyed by the session id the write was
 * for, so none shows under another session and a late reply never lands
 * elsewhere.
 */
export function useSessionWrites(id: string, transcriptEnd = 0) {
  const { t } = useLingui()
  const follow = useNavigateToSession()
  // where the transcript ended when a message was sent: only user lines
  // after it can be that message (an earlier identical "继续" is not)
  const endRef = useRef(transcriptEnd)
  endRef.current = transcriptEnd
  const client = useQueryClient()
  const pendingRaw = usePending(id)
  const [stateBy, setStateBy] = useState<Record<string, WriteState>>({})
  const state = stateBy[id] ?? IDLE
  const patch = (target: string, next: Partial<WriteState>) =>
    setStateBy((all) => ({
      ...all,
      [target]: { ...(all[target] ?? IDLE), ...next },
    }))

  const write = async (target: string, job: () => Promise<void>) => {
    patch(target, { sending: true, error: '' })
    try {
      await job()
      // the poll would catch up anyway; don't hold the composer on it
      void client.invalidateQueries({ queryKey: ['remote', 'session', target] })
      return true
    } catch (e) {
      patch(target, { error: (e as Error).message })
      return false
    } finally {
      patch(target, { sending: false, retryIn: 0 })
    }
  }
  const followReply = (target: string, reply: unknown) => {
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
  /** an allowlisted pane key (1/2/3/4, Enter, Esc, Up/Down/Tab, C-c), or
   * session.restart (重启会话 / 新开会话) */
  const run = (
    action: 'key' | 'session.restart',
    args: Record<string, unknown>,
  ) => {
    const target = id
    const op_id = crypto.randomUUID()
    return write(target, async () => {
      trace('web-write', { id: target, op_id, action, stage: 'requested' })
      try {
        const reply = await hostWrite(action, {
          id: target,
          ...args,
          client_op: op_id,
        })
        if (action === 'session.restart' && args.fresh === true)
          followReply(target, reply)
        void client.invalidateQueries({ queryKey: ['remote', 'sessions'] })
        trace('web-write', {
          id: target,
          op_id,
          action,
          stage: 'host-accepted',
        })
      } catch (error) {
        trace('web-write', { id: target, op_id, action, stage: 'failed' })
        throw error
      }
    })
  }
  const send = (message: Outgoing) => {
    const target = id
    const op_id = crypto.randomUUID()
    // a slash command (/new, /clear, /compact…) is run by the TUI, never
    // written to the transcript as a message: queued as one it waited for
    // the agent forever
    const command = commandOf(message.text)
    // optimistic: the bubble shows at once (sending), turns queued when the
    // host took it, and leaves when the transcript shows the message
    const at = Date.now()
    const mark = (next?: Pending['state']) =>
      updatePending(target, (list) =>
        next
          ? list.map((item) =>
              item.at === at ? { ...item, state: next } : item,
            )
          : list.filter((item) => item.at !== at),
      )
    if (!command)
      updatePending(target, (list) => [
        ...list,
        {
          text: message.text,
          note: message.note,
          attachments: message.attachments,
          clientOp: op_id,
          at,
          after: endRef.current,
          state: 'sending',
        },
      ])
    return write(target, async () => {
      trace('web-write', {
        id: target,
        op_id,
        action: 'send',
        stage: 'requested',
      })
      try {
        const reply = await withDeskRetry(
          () =>
            hostWrite('send', {
              id: target,
              text: message.text,
              attachments: message.attachments,
              client_op: op_id,
            }),
          (seconds) => patch(target, { retryIn: seconds }),
        )
        if (command === '/new') followReply(target, reply)
      } catch (error) {
        // refused: the text goes back to the composer with the error
        if (!command) mark()
        void client.invalidateQueries({ queryKey: ['remote', 'sent'] })
        trace('web-write', {
          id: target,
          op_id,
          action: 'send',
          stage: 'failed',
        })
        throw error
      }
      trace('web-write', {
        id: target,
        op_id,
        action: 'send',
        stage: 'host-accepted',
      })
      void client.invalidateQueries({ queryKey: ['remote', 'sent'] })
      if (command) {
        void client.invalidateQueries({ queryKey: ['remote', 'sessions'] })
        toast(t`Command sent: ${command}`)
      } else mark('queued')
    })
  }
  /** drop a bubble (a lost or failed one the user gave up on) */
  const dismiss = (item: Pending) => {
    updatePending(id, (list) =>
      list.filter(
        (one) =>
          one.at !== item.at &&
          (!item.clientOp || one.clientOp !== item.clientOp),
      ),
    )
    if (item.sentId) {
      void hostWrite('sent.action', { op: 'dismiss', id: item.sentId })
        .then(() =>
          Promise.all([
            client.invalidateQueries({ queryKey: ['remote', 'session', id] }),
            client.invalidateQueries({ queryKey: ['remote', 'sent'] }),
          ]),
        )
        .catch(() => undefined)
    }
  }
  /** a lost / failed bubble, sent again as a new message (new time, new anchor) */
  const resend = (item: Pending) => {
    dismiss(item)
    return send({
      text: item.text,
      attachments: item.attachments ?? [],
      note: item.note ?? '',
    })
  }
  const setError = (error: string) => patch(id, { error })
  return {
    sending: state.sending,
    error: state.error,
    setError,
    retryIn: state.retryIn,
    pendingRaw,
    send,
    run,
    dismiss,
    /**
     * ChatThread's bubble props: the queue, and resend / edit / remove on a
     * lost (未送达) or failed one — resend only while this device may write
     */
    pendingProps: (
      canWrite: boolean,
      onEdit?: (item: Pending) => void,
      onTicket?: (item: Pending) => void,
    ) => ({
      pending: pendingRaw,
      onResend: canWrite ? (item: Pending) => void resend(item) : undefined,
      onEdit,
      onTicket: canWrite ? onTicket : undefined,
      onDismiss: dismiss,
    }),
  }
}
