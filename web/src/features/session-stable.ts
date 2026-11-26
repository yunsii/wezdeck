// A row shown under the current filter stays until the filter changes, so a
// session that finishes (运行中) or is answered (等你) does not vanish mid-pass.
// Re-tapping 会话 (the tab, or the sidebar entry while on it) re-reads membership.
import { useSyncExternalStore } from 'react'

let shown = { filter: '', ids: new Set<string>() }

// a reset must re-render the list itself: a refetch that returns the same
// sessions keeps the same data object, so nothing else would
let version = 0
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const useVersion = () =>
  useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  )

/** re-read membership now (an explicit refresh) */
export function resetSessionOrder() {
  shown = { filter: '', ids: new Set() }
  version += 1
  for (const listener of listeners) listener()
}

/** ids to list under `filter`: the matching ones plus those already shown */
export function useStickyMembers(filter: string, matching: Array<string>) {
  useVersion()
  if (shown.filter !== filter) shown = { filter, ids: new Set<string>() }
  for (const id of matching) shown.ids.add(id)
  return shown.ids
}
