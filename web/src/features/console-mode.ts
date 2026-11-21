import { useSyncExternalStore } from 'react'

import { forcedRemote, remoteLink } from '#/lib/remote-link'
import type { RemoteState } from '#/lib/remote-link'
import { useRuntimeData } from './console-data'

const SERVER_REMOTE: RemoteState = {
  mode: 'unpaired',
  rpcCount: { webrtc: 0, websocket: 0 },
}

export function useRemoteState() {
  return useSyncExternalStore(
    remoteLink.subscribe,
    remoteLink.snapshot,
    () => SERVER_REMOTE,
  )
}

/**
 * local  — loopback Runtime answers: every console section.
 * remote — no Runtime (phone / tablet, or ?remote=1): collab sections only.
 * checking — first probe still running.
 */
const noop = () => () => undefined

export function useConsoleMode(): 'local' | 'remote' | 'checking' {
  const runtime = useRuntimeData()
  // location / sessionStorage are client-only: stay "checking" until hydrated
  // so the server HTML and the first client render agree.
  const hydrated = useSyncExternalStore(
    noop,
    () => true,
    () => false,
  )
  if (!hydrated) return 'checking'
  if (forcedRemote()) return 'remote'
  if (runtime.connected) return 'local'
  if (runtime.loading) return 'checking'
  return 'remote'
}
