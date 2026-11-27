// Writes from the session page: messages (with attachments) and confirmation
// keys, the queue of sent-but-not-yet-in-the-transcript bubbles, and the
// countdown when the host asks to wait for the desk to go quiet.
import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { toast } from 'sonner'

import {
  acceptSessionOptimistic,
  applySessionOptimistic,
  createSerialQueue,
  onOptimisticTimeout,
  promptFingerprint,
  rollbackSessionOptimistic,
  transferSessionOptimistic,
} from '#/lib/optimistic-state'
import { hostWrite } from '#/lib/runtime-client'
import { trace } from '#/lib/client-trace'

import type { Pending } from './chat-thread'
import type { Outgoing } from './session-composer'
import type { Detail } from './session-detail-types'
import { useNavigateToSession } from './session-follow'
import {
  commandOf,
  mergeOutboxPending as mergeOutboxPendingRaw,
  withDeskRetry,
} from './session-send-helpers'
import type { SentRecord } from './sent-history'

export { useFollowReplacement } from './session-follow'
export { commandOf, withDeskRetry }

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
const dismissedOutboxIds = new Set<string>()
let dismissedVersion = 0
const pendingListeners = new Set<() => void>()
const PENDING_KEEP_MS = 6 * 60 * 60_000
const sendQueue = createSerialQueue()

function useDismissedVersion() {
  return useSyncExternalStore(
    (listener) => {
      pendingListeners.add(listener)
      return () => pendingListeners.delete(listener)
    },
    () => dismissedVersion,
    () => 0,
  )
}

/** Merge local pending bubbles with host outbox, hiding optimistically dismissed records. */
export function mergeOutboxPending(
  local: Array<Pending>,
  hostOutbox?: Array<SentRecord>,
): Array<Pending> {
  return mergeOutboxPendingRaw(local, hostOutbox, dismissedOutboxIds)
}

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
  transferSessionOptimistic(from, to)
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

type WriteRunner = (
  target: string,
  job: () => Promise<void>,
  opts?: { lockComposer?: boolean },
) => Promise<boolean>

function followSessionReply(
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

function buildBaseline(
  snapshot: Detail | undefined,
  transcriptEnd: number,
  promptKey?: string,
) {
  return {
    status: snapshot?.status,
    ts: snapshot?.ts,
    waitingKind: snapshot?.waiting_kind,
    promptKey: promptKey ?? promptFingerprint(snapshot),
    transcriptEnd,
  }
}

function createSendMessage({
  target,
  message,
  baseline,
  client,
  patch,
  write,
  follow,
  commandSentToast,
}: {
  target: string
  message: Outgoing
  baseline: ReturnType<typeof buildBaseline>
  client: ReturnType<typeof useQueryClient>
  patch: (target: string, next: Partial<WriteState>) => void
  write: WriteRunner
  follow: (from: string, to: string) => void
  commandSentToast: (command: string) => void
}): Promise<boolean> {
  const op_id = crypto.randomUUID()
  const command = commandOf(message.text)
  const at = Date.now()
  const updateItem = (patchItem: Partial<Pending> | null) =>
    updatePending(target, (list) =>
      patchItem
        ? list.map((item) =>
            item.at === at && item.clientOp === op_id
              ? { ...item, ...patchItem }
              : item,
          )
        : list.filter((item) => !(item.at === at && item.clientOp === op_id)),
    )
  if (!command) {
    updatePending(target, (list) => [
      ...list,
      {
        text: message.text,
        note: message.note,
        attachments: message.attachments,
        localPreviews: message.localPreviews,
        clientOp: op_id,
        at,
        after: baseline.transcriptEnd,
        state: 'sending',
      },
    ])
    applySessionOptimistic({
      id: target,
      opId: op_id,
      kind: 'send',
      createdAt: at,
      promptText: message.text || message.note,
      baseline,
    })
  }
  const execute = async () => {
    trace('web-write', {
      id: target,
      op_id,
      action: 'send',
      stage: 'requested',
    })
    try {
      let attachments = message.attachments
      if (message.materialize) {
        attachments = await message.materialize((label) =>
          updateItem({ uploading: label }),
        )
        updateItem({
          attachments,
          uploading: undefined,
          localPreviews: undefined,
        })
      }
      const reply = await withDeskRetry(
        () =>
          hostWrite('send', {
            id: target,
            text: message.text,
            attachments,
            client_op: op_id,
          }),
        (seconds) => patch(target, { retryIn: seconds }),
      )
      if (command === '/new') followSessionReply(follow, target, reply)
    } catch (error) {
      if (!command) {
        updateItem(null)
        rollbackSessionOptimistic(target, op_id, (error as Error).message)
      }
      void client.invalidateQueries({ queryKey: ['remote', 'sent'] })
      trace('web-write', { id: target, op_id, action: 'send', stage: 'failed' })
      throw error
    }
    trace('web-write', {
      id: target,
      op_id,
      action: 'send',
      stage: 'host-accepted',
    })
    void client.invalidateQueries({ queryKey: ['remote', 'sent'] })
    void client.invalidateQueries({ queryKey: ['remote', 'sessions'] })
    if (command) {
      commandSentToast(command)
    } else {
      updateItem({ state: 'queued', uploading: undefined })
      acceptSessionOptimistic(target, op_id)
    }
  }
  if (command) return write(target, execute, { lockComposer: true })
  return sendQueue
    .enqueue(`send:${target}`, () =>
      write(target, execute, { lockComposer: false }),
    )
    .then((res) => (res.ok ? res.value : false))
}

/**
 * Per session, not per page: queued bubbles (above, page-wide), the sending
 * state, an error or a countdown are keyed by the session id the write was
 * for, so none shows under another session and a late reply never lands
 * elsewhere.
 */
export function useSessionWrites(
  id: string,
  transcriptEnd = 0,
  snapshot?: Detail,
) {
  const { t } = useLingui()
  const follow = useNavigateToSession()
  const endRef = useRef(transcriptEnd)
  endRef.current = transcriptEnd
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const client = useQueryClient()
  const pendingRaw = usePending(id)
  useDismissedVersion()
  useEffect(
    () =>
      onOptimisticTimeout((event) => {
        if (
          event.scope === 'session' &&
          event.id === id &&
          (event.kind === 'prompt-submit' || event.kind === 'prompt-cancel')
        ) {
          toast.warning(
            t`The host did not confirm the action; please check and retry.`,
          )
        }
      }),
    [id, t],
  )
  const [stateBy, setStateBy] = useState<Record<string, WriteState>>({})
  const state = stateBy[id] ?? IDLE
  const patch = (target: string, next: Partial<WriteState>) =>
    setStateBy((all) => ({
      ...all,
      [target]: { ...(all[target] ?? IDLE), ...next },
    }))

  const write: WriteRunner = async (target, job, opts) => {
    const lock = opts?.lockComposer ?? true
    patch(target, lock ? { sending: true, error: '' } : { error: '' })
    try {
      await job()
      void client.invalidateQueries({ queryKey: ['remote', 'session', target] })
      return true
    } catch (e) {
      patch(target, { error: (e as Error).message })
      return false
    } finally {
      patch(target, lock ? { sending: false, retryIn: 0 } : { retryIn: 0 })
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
    const isInterrupt = action === 'key' && args.interrupt === true
    if (isInterrupt) {
      applySessionOptimistic({
        id: target,
        opId: op_id,
        kind: 'interrupt',
        baseline: buildBaseline(snapshotRef.current, endRef.current),
      })
    }
    return write(
      target,
      async () => {
        trace('web-write', { id: target, op_id, action, stage: 'requested' })
        try {
          const reply = await hostWrite(action, {
            id: target,
            ...args,
            client_op: op_id,
          })
          if (action === 'session.restart' && args.fresh === true)
            followSessionReply(follow, target, reply)
          if (
            isInterrupt &&
            reply &&
            typeof reply === 'object' &&
            'interrupted' in reply &&
            typeof reply.interrupted === 'boolean'
          ) {
            if (reply.interrupted) {
              acceptSessionOptimistic(target, op_id)
              toast(t`Turn interrupted`)
            } else {
              rollbackSessionOptimistic(target, op_id, 'not-confirmed')
              throw new Error(
                t`Interrupt sent, but the agent has not confirmed it.`,
              )
            }
          } else if (isInterrupt) {
            acceptSessionOptimistic(target, op_id)
          }
          void client.invalidateQueries({ queryKey: ['remote', 'sessions'] })
          trace('web-write', {
            id: target,
            op_id,
            action,
            stage: 'host-accepted',
          })
        } catch (error) {
          if (isInterrupt) {
            rollbackSessionOptimistic(target, op_id, (error as Error).message)
          }
          trace('web-write', { id: target, op_id, action, stage: 'failed' })
          throw error
        }
      },
      { lockComposer: action === 'session.restart' },
    )
  }

  /** Optimistically dismiss an interactive prompt card and send its keys in the background. */
  const resolvePrompt = (opts: {
    kind: 'prompt-submit' | 'prompt-cancel'
    promptKey: string
    execute: () => Promise<boolean>
  }): Promise<boolean> => {
    const target = id
    const op_id = crypto.randomUUID()
    applySessionOptimistic({
      id: target,
      opId: op_id,
      kind: opts.kind,
      suppressedPromptKey: opts.promptKey,
      baseline: buildBaseline(
        snapshotRef.current,
        endRef.current,
        opts.promptKey,
      ),
    })
    patch(target, { error: '' })
    return opts
      .execute()
      .then((ok) => {
        if (!ok) {
          rollbackSessionOptimistic(target, op_id, 'key-failed')
          return false
        }
        acceptSessionOptimistic(target, op_id)
        void client.invalidateQueries({
          queryKey: ['remote', 'session', target],
        })
        void client.invalidateQueries({ queryKey: ['remote', 'sessions'] })
        return true
      })
      .catch((error: unknown) => {
        rollbackSessionOptimistic(target, op_id, (error as Error).message)
        patch(target, { error: (error as Error).message })
        return false
      })
  }

  const send = (message: Outgoing) =>
    createSendMessage({
      target: id,
      message,
      baseline: buildBaseline(snapshotRef.current, endRef.current),
      client,
      patch,
      write,
      follow,
      commandSentToast: (command) => toast(t`Command sent: ${command}`),
    })
  /** drop a bubble (a lost or failed one the user gave up on) */
  const dismiss = (item: Pending) => {
    if (item.sentId) {
      dismissedOutboxIds.add(item.sentId)
      dismissedVersion += 1
    }
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
    resolvePrompt,
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
