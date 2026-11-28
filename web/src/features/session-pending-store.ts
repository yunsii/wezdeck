import { useSyncExternalStore } from 'react'
import type { Pending } from './chat-pending'

export function usePendingBubbles(
  id: string,
  store: Map<string, Array<Pending>>,
  listeners: Set<() => void>,
  empty: Array<Pending>,
) {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => store.get(id) ?? empty,
    () => empty,
  )
}

export function usePendingVersion(
  listeners: Set<() => void>,
  version: () => number,
) {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    version,
    () => 0,
  )
}
