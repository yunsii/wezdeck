// Writes from the session page: messages (with attachments) and confirmation
// keys, the queue of sent-but-not-yet-in-the-transcript bubbles, and the
// countdown when the host asks to wait for the desk to go quiet.
import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { toast } from 'sonner'

import { useLocale } from '#/lib/locale-context'
import { hostWrite } from '#/lib/runtime-client'

import type { Pending } from './chat-thread'
import type { Outgoing } from './session-composer'

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

/**
 * /new, /clear or /resume in the pane switches the conversation there; the
 * host then answers the previous id with replaced_by (relay liveSessions).
 * Follow it, in place of this page in history, and say so.
 */
export function useFollowReplacement(replacedBy?: string) {
  const { t } = useLingui()
  const navigate = useNavigate()
  const { locale } = useLocale()
  useEffect(() => {
    if (!replacedBy) return
    toast(t`This pane switched sessions`)
    void navigate({
      to: '/{-$locale}/console/sessions/$id',
      params: { locale: locale === 'en' ? undefined : locale, id: replacedBy },
      replace: true,
    })
  }, [replacedBy, navigate, locale, t])
}

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
  /** an allowlisted pane key (1/2/3/4, Enter, Esc, Up/Down/Tab, C-c), or
   * session.restart (重启会话 / 新开会话) */
  const run = (
    action: 'key' | 'session.restart',
    args: Record<string, unknown>,
  ) => {
    const target = id
    return write(target, async () => {
      await hostWrite(action, { id: target, ...args })
    })
  }
  const send = (message: Outgoing) => {
    const target = id
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
          at,
          after: endRef.current,
          state: 'sending',
        },
      ])
    return write(target, async () => {
      try {
        await withDeskRetry(
          () =>
            hostWrite('send', {
              id: target,
              text: message.text,
              attachments: message.attachments,
            }),
          (seconds) => patch(target, { retryIn: seconds }),
        )
      } catch (error) {
        // refused: the text goes back to the composer with the error
        if (!command) mark()
        throw error
      }
      if (command) toast(t`Command sent: ${command}`)
      else mark('queued')
    })
  }
  /** drop a bubble (a lost one the user gave up on) */
  const dismiss = (item: Pending) =>
    updatePending(id, (list) => list.filter((one) => one.at !== item.at))
  /** a lost bubble, sent again as a new message (new time, new anchor) */
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
    /**
     * ChatThread's bubble props: the queue, and resend / remove on a lost
     * (未送达) one — resend only while this device may write
     */
    pendingProps: (canWrite: boolean) => ({
      pending: pendingRaw,
      onResend: canWrite ? (item: Pending) => void resend(item) : undefined,
      onDismiss: dismiss,
    }),
  }
}
