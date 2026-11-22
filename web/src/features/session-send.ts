// Writes from the session page: messages (with attachments) and confirmation
// keys, the queue of sent-but-not-yet-in-the-transcript bubbles, and the
// countdown when the host asks to wait for the desk to go quiet.
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { remoteLink } from '#/lib/remote-link'
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

export function useSessionWrites(id: string) {
  const client = useQueryClient()
  const [pendingRaw, setPending] = useState<Array<Pending>>([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [retryIn, setRetryIn] = useState(0)
  const refresh = () =>
    client.invalidateQueries({ queryKey: ['remote', 'session', id] })

  const write = async (job: () => Promise<void>) => {
    setSending(true)
    setError('')
    try {
      await job()
      // the poll would catch up anyway; don't hold the composer on it
      void refresh()
      return true
    } catch (e) {
      setError((e as Error).message)
      return false
    } finally {
      setSending(false)
      setRetryIn(0)
    }
  }
  /** an allowlisted pane key (1/2/3/4, Enter, Esc, Up/Down/Tab, C-c) */
  const run = (action: 'key', args: Record<string, unknown>) =>
    write(async () => {
      await remoteLink.write(action, { id, ...args })
    })
  const send = (message: Outgoing) =>
    write(async () => {
      await withDeskRetry(
        () =>
          remoteLink.write('send', {
            id,
            text: message.text,
            attachments: message.attachments,
          }),
        setRetryIn,
      )
      setPending((items) => [
        ...items,
        { text: message.text, note: message.note, at: Date.now() },
      ])
    })
  return { sending, error, setError, retryIn, pendingRaw, send, run }
}
