// Writes from the session page: messages (with attachments) and confirmation
// keys, the queue of sent-but-not-yet-in-the-transcript bubbles, and the
// countdown when the host asks to wait for the desk to go quiet.
import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { toast } from 'sonner'

import {
  acceptSessionOptimistic,
  applySessionOptimistic,
  createSerialQueue,
  rollbackSessionOptimistic,
  transferSessionOptimistic,
} from '#/lib/optimistic-state'
import { hostWrite } from '#/lib/runtime-client'
import { trace } from '#/lib/client-trace'

import type { Pending } from './chat-thread'
import type { Outgoing } from './session-composer'
import type { Detail } from './session-detail-types'
import { mergeDeferredPending } from './session-deferred'
import type { DeferredRecord } from './session-deferred'
import { usePromptTimeoutNotice } from './session-prompt-timeout'
import { createRunSessionAction } from './session-run-action'
import type { WriteRunner } from './session-run-action'
import { createPendingBubbleProps } from './session-pending-props'
import { usePendingBubbles, usePendingVersion } from './session-pending-store'
import { useNavigateToSession } from './session-follow'
import {
  commandOf,
  createResolvePrompt,
  currentSessionBaseline,
  followSessionReply,
  mergeOutboxPending as mergeOutboxPendingRaw,
  withDeskRetry,
} from './session-send-helpers'
import type { buildSessionBaseline } from './session-send-helpers'
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
const dismissedDeferredIds = new Set<string>()
let dismissedVersion = 0
const pendingListeners = new Set<() => void>()
const PENDING_KEEP_MS = 6 * 60 * 60_000
const sendQueue = createSerialQueue()

/** Merge local pending bubbles with host outbox, hiding optimistically dismissed records. */
export function mergeOutboxPending(
  local: Array<Pending>,
  hostOutbox?: Array<SentRecord>,
  outboxReadStartedAt?: number,
  hostDeferred?: Array<DeferredRecord>,
): Array<Pending> {
  return mergeDeferredPending(
    mergeOutboxPendingRaw(
      local,
      hostOutbox,
      dismissedOutboxIds,
      outboxReadStartedAt,
    ),
    hostDeferred,
    dismissedDeferredIds,
    outboxReadStartedAt,
  )
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

function createSendMessage({
  target,
  message,
  baseline,
  client,
  patch,
  write,
  follow,
  commandSentToast,
  submitFailedMessage,
}: {
  target: string
  message: Outgoing
  baseline: ReturnType<typeof buildSessionBaseline>
  client: ReturnType<typeof useQueryClient>
  patch: (target: string, next: Partial<WriteState>) => void
  write: WriteRunner
  follow: (from: string, to: string) => void
  commandSentToast: (command: string) => void
  submitFailedMessage: (opId: string) => string
}): Promise<boolean> {
  const op_id = message.clientOp ?? crypto.randomUUID()
  const command = commandOf(message.text)
  const policy = message.deliveryPolicy ?? 'immediate'
  const at = Date.now()
  const updateItem = (patchItem: Partial<Pending> | null) => {
    // A pending session may resolve while its write is still in flight.
    const hasWrite = (item: Pending) => item.clientOp === op_id
    const owner = pendingStore.get(target)?.some(hasWrite)
      ? target
      : [...pendingStore].find(([, items]) => items.some(hasWrite))?.[0]
    if (!owner) return
    updatePending(owner, (list) =>
      patchItem
        ? list.map((item) =>
            hasWrite(item) ? { ...item, ...patchItem } : item,
          )
        : list.filter((item) => !hasWrite(item)),
    )
  }
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
    if (policy === 'immediate') {
      applySessionOptimistic({
        id: target,
        opId: op_id,
        kind: 'send',
        createdAt: at,
        promptText: message.text || message.note,
        baseline,
      })
    }
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
      if (!command && policy !== 'immediate') {
        const reply = (await hostWrite('deferred.enqueue', {
          id: target,
          text: message.text,
          attachments,
          policy,
          client_op: op_id,
        })) as { item: DeferredRecord }
        client.setQueryData<Detail>(['remote', 'session', target], (old) =>
          old
            ? {
                ...old,
                deferred: [
                  ...(old.deferred ?? []).filter(
                    (item) => item.id !== reply.item.id,
                  ),
                  reply.item,
                ],
              }
            : old,
        )
        updateItem({
          text: message.text,
          note: message.note,
          attachments,
          at,
          after: baseline.transcriptEnd,
          clientOp: op_id,
          state: 'deferred',
          deferredId: reply.item.id,
          deferredArmedAt: reply.item.armed_at,
          acceptedAt: Date.now(),
        })
        trace('web-write', {
          id: target,
          op_id,
          action: 'deferred-enqueue',
          policy,
          stage: 'accepted',
        })
        return
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
      const partial = (error as Error).message.startsWith(
        'tmux submit failed after paste: ',
      )
      trace('web-write', {
        id: target,
        op_id,
        action: 'send',
        stage: partial ? 'submit-failed' : 'failed',
      })
      if (partial) throw new Error(submitFailedMessage(op_id))
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
      updateItem({
        state: 'queued',
        acceptedAt: Date.now(),
        uploading: undefined,
      })
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
  const resolvingRef = useRef(0)
  const client = useQueryClient()
  const currentBaseline = (promptKey?: string) =>
    currentSessionBaseline(
      client,
      id,
      snapshotRef.current,
      endRef.current,
      promptKey,
    )
  const pendingRaw = usePendingBubbles(id, pendingStore, pendingListeners, NONE)
  usePendingVersion(pendingListeners, () => dismissedVersion)
  usePromptTimeoutNotice(id)
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
      if (opts?.invalidate !== false) {
        void client.invalidateQueries({
          queryKey: ['remote', 'session', target],
        })
      }
      return true
    } catch (e) {
      patch(target, { error: (e as Error).message })
      return false
    } finally {
      patch(target, lock ? { sending: false, retryIn: 0 } : { retryIn: 0 })
    }
  }
  const run = createRunSessionAction({
    target: id,
    baseline: currentBaseline,
    client,
    follow,
    resolvingRef,
    write,
    onInterrupted: () => toast(t`Turn interrupted`),
    interruptNotConfirmed: () =>
      t`Interrupt sent, but the agent has not confirmed it.`,
  })
  /** Optimistically dismiss an interactive prompt card and send its keys in the background. */
  const resolvePrompt = (opts: {
    kind: 'prompt-submit' | 'prompt-cancel'
    promptKey: string
    execute: () => Promise<boolean>
  }) =>
    createResolvePrompt({
      target: id,
      baseline: currentBaseline(opts.promptKey),
      client,
      onError: (message) => patch(id, { error: message }),
      resolvingRef,
      opts,
    })

  const send = (message: Outgoing) =>
    createSendMessage({
      target: id,
      message,
      baseline: currentBaseline(),
      client,
      patch,
      write,
      follow,
      commandSentToast: (command) => toast(t`Command sent: ${command}`),
      submitFailedMessage: (op_id) =>
        t`The message was pasted, but tmux could not press Enter. Check the terminal input before retrying. Diagnostic ID: ${op_id}`,
    })
  /** drop a bubble (a lost or failed one the user gave up on) */
  const dismiss = (item: Pending) => {
    if (item.deferredId) {
      dismissedDeferredIds.add(item.deferredId)
      dismissedVersion += 1
      void hostWrite('deferred.cancel', { id: item.deferredId })
        .then(() =>
          client.invalidateQueries({ queryKey: ['remote', 'session', id] }),
        )
        .catch((error: unknown) => {
          dismissedDeferredIds.delete(item.deferredId!)
          dismissedVersion += 1
          patch(id, { error: (error as Error).message })
        })
    }
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
    if (item.deferredId) {
      return hostWrite('deferred.release', { id: item.deferredId })
        .then(() => {
          updatePending(id, (list) =>
            list.filter((one) => one.deferredId !== item.deferredId),
          )
          void client.invalidateQueries({ queryKey: ['remote', 'session', id] })
          void client.invalidateQueries({ queryKey: ['remote', 'sent'] })
          return true
        })
        .catch((error: unknown) => {
          patch(id, { error: (error as Error).message })
          void client.invalidateQueries({ queryKey: ['remote', 'session', id] })
          return false
        })
    }
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
    mergedPending: mergeOutboxPending(
      pendingRaw,
      snapshot?.outbox,
      snapshot?.outboxReadStartedAt,
      snapshot?.deferred,
    ),
    send,
    run,
    resolvePrompt,
    dismiss,
    pendingProps: createPendingBubbleProps(
      pendingRaw,
      (item) => void resend(item),
      dismiss,
    ),
  }
}
