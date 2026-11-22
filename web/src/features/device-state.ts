// Whether this phone may write: none → (enable) → pending → (host runs
// install-remote-relay.sh --approve <id>) → approved. The host is the
// source of truth; asking it again is how the phone learns about approval.
import { useEffect, useSyncExternalStore } from 'react'

import { createDeviceKey, loadDeviceKey } from '#/lib/device-key'
import { remoteLink } from '#/lib/remote-link'

export type DeviceWriteState = 'checking' | 'none' | 'pending' | 'approved'

let state: { state: DeviceWriteState; id?: string; error?: string } = {
  state: 'checking',
}
const listeners = new Set<() => void>()
const set = (next: typeof state) => {
  state = next
  listeners.forEach((listener) => listener())
}

async function ask(create: boolean) {
  try {
    const key = create ? await createDeviceKey() : await loadDeviceKey()
    if (!key) {
      set({ state: 'none' })
      return
    }
    const name =
      typeof navigator !== 'undefined'
        ? (navigator.userAgent.match(/\(([^;)]+)/)?.[1] ?? 'browser')
        : 'browser'
    const result = (await remoteLink.rpc('device.register', {
      public_key: key.publicRaw,
      name,
    })) as { state: 'pending' | 'approved' }
    set({ state: result.state, id: key.id })
  } catch (error) {
    const key = await loadDeviceKey()
    set({
      state: key ? 'pending' : 'none',
      id: key?.id,
      error: (error as Error).message,
    })
  }
}

let started = false

export function useDeviceState() {
  const snapshot = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => state,
    () => state,
  )
  useEffect(() => {
    if (started) return
    started = true
    void ask(false)
  }, [])
  return {
    ...snapshot,
    enable: () => ask(true),
    refresh: () => ask(false),
  }
}
