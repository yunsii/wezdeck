// Writes from the session page: messages (with attachments) and confirmation
// keys, the queue of sent-but-not-yet-in-the-transcript bubbles, and the
// countdown when the host asks to wait for the desk to go quiet.
import { useQueryClient } from '@tanstack/react-query'
import { hostWrite } from '#/lib/runtime-client'
import { useState } from 'react'

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

type WriteState = { sending: boolean; error: string; retryIn: number }
const IDLE: WriteState = { sending: false, error: '', retryIn: 0 }
const NONE: Array<Pending> = []

/**
 * Per session, not per page: the session page stays mounted while you move
 * to another session (Alt+j, the switcher, the split list), so queued
 * bubbles, the sending state, an error or a countdown kept in plain state
 * showed up under the next session. Everything is keyed by the session id
 * the write was for, which also keeps a late reply from landing elsewhere.
 */
export function useSessionWrites(id: string) {
  const client = useQueryClient()
  const [pendingBy, setPendingBy] = useState<Record<string, Array<Pending>>>({})
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
  /** an allowlisted pane key (1/2/3/4, Enter, Esc, Up/Down/Tab, C-c) */
  const run = (action: 'key', args: Record<string, unknown>) => {
    const target = id
    return write(target, async () => {
      await hostWrite(action, { id: target, ...args })
    })
  }
  const send = (message: Outgoing) => {
    const target = id
    return write(target, async () => {
      await withDeskRetry(
        () =>
          hostWrite('send', {
            id: target,
            text: message.text,
            attachments: message.attachments,
          }),
        (seconds) => patch(target, { retryIn: seconds }),
      )
      setPendingBy((all) => ({
        ...all,
        [target]: [
          ...(all[target] ?? []),
          { text: message.text, note: message.note, at: Date.now() },
        ],
      }))
    })
  }
  const setError = (error: string) => patch(id, { error })
  return {
    sending: state.sending,
    error: state.error,
    setError,
    retryIn: state.retryIn,
    pendingRaw: pendingBy[id] ?? NONE,
    send,
    run,
  }
}
