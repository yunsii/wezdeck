// Keep the screen on while a session page is open (Screen Wake Lock): the
// phone sits on the desk following an agent. Browsers drop the lock when the
// page is hidden, so it is taken again on return; it is released when the
// page unmounts. Unsupported browsers just don't get it — outcomes go to the
// client trace (lib/client-trace.ts) so a diagnostics snapshot shows them.
import { useEffect } from 'react'

import { trace } from '#/lib/client-trace'

type Sentinel = { release: () => Promise<void>; released: boolean }
type WakeLock = { request: (type: 'screen') => Promise<Sentinel> }

export function useScreenWakeLock(active: boolean) {
  useEffect(() => {
    if (!active) return
    // typed as always there; older browsers (some Firefox builds) lack it
    if (!('wakeLock' in navigator)) {
      trace('wake-lock', { ok: false, reason: 'unsupported' })
      return
    }
    const lock = navigator.wakeLock as unknown as WakeLock
    let sentinel: Sentinel | null = null
    let gone = false
    const take = async () => {
      if (
        document.visibilityState !== 'visible' ||
        (sentinel && !sentinel.released)
      )
        return
      try {
        sentinel = await lock.request('screen')
        trace('wake-lock', { ok: true })
        if (gone) void sentinel.release()
      } catch (error) {
        trace('wake-lock', { ok: false, reason: (error as Error).message })
      }
    }
    void take()
    document.addEventListener('visibilitychange', take)
    return () => {
      gone = true
      document.removeEventListener('visibilitychange', take)
      void sentinel?.release()
    }
  }, [active])
}
