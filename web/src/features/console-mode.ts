import { useEffect, useSyncExternalStore } from 'react'

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

const LAST_MODE = 'wezdeck.console-mode'

/**
 * For layout only (the top band, local-only sidebar entries): while the
 * first probe runs, the mode this browser had last time, instead of
 * rendering the remote layout and swapping it a moment later — the band
 * flashed 远程访问 and jumped on every load on the host. `checking` stays
 * only before hydration (the server cannot know), where the band renders
 * empty at its fixed height.
 */
export function useLayoutMode(): 'local' | 'remote' | 'checking' {
  const mode = useConsoleMode()
  const hydrated = useSyncExternalStore(
    noop,
    () => true,
    () => false,
  )
  useEffect(() => {
    if (mode === 'checking') return
    try {
      localStorage.setItem(LAST_MODE, mode)
    } catch {
      // storage blocked: the guess just stays "checking"
    }
  }, [mode])
  if (mode !== 'checking' || !hydrated) return mode
  try {
    const last = localStorage.getItem(LAST_MODE)
    return last === 'local' || last === 'remote' ? last : 'checking'
  } catch {
    return 'checking'
  }
}
