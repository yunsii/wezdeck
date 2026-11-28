// What the session page does for as long as it is shown, besides drawing
// the conversation (console-sessions.tsx SessionDetail).
import { useScreenWakeLock } from '#/lib/wake-lock'
import type { Detail } from './console-sessions'
import { useSeenAck } from './session-clear'

/**
 * Keep the screen awake while following an agent and count a done session as
 * seen on the host. Foreground refetch lives with the transient notice.
 */
export function useWhileShown(
  id: string,
  data: Detail | undefined,
  writable: boolean,
) {
  useScreenWakeLock(true)
  useSeenAck(id, data?.status, data?.ts, writable)
}
