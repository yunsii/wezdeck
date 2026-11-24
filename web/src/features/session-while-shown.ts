// What the session page does for as long as it is shown, besides drawing
// the conversation (console-sessions.tsx SessionDetail).
import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'

import { useScreenWakeLock } from '#/lib/wake-lock'
import type { Detail } from './console-sessions'
import { useSeenAck } from './session-clear'

/**
 * Back from the background (phone unlocked, tab shown): refetch at once
 * instead of waiting for the next poll. Silent — a status line saying "up
 * to date" on every return was noise; only repeated failures speak up
 * (useFailedPolls).
 */
function useResumeRefetch(id: string) {
  const client = useQueryClient()
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      void client.invalidateQueries({ queryKey: ['remote', 'session', id] })
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [client, id])
}

/**
 * Refetch on return from the background, keep the screen awake (the phone
 * often sits on the desk following the agent), and count a done session
 * as seen on the host (useSeenAck).
 */
export function useWhileShown(
  id: string,
  data: Detail | undefined,
  writable: boolean,
) {
  useResumeRefetch(id)
  useScreenWakeLock(true)
  useSeenAck(id, data?.status, data?.ts, writable)
}
