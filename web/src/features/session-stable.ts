// The session list holds still while you use it (session-list.tsx), the
// same on a phone and a wide screen. Both records live for the page, not
// for the list component: a phone remounts the list every time it comes
// back from a session, which re-read the visits and lifted the session just
// opened to the top — the wide split, mounted throughout, did not.
//  - order: each worktree's visit is read once, when the list first sees
//    it, so opening a session (a visit) or Alt+g at the desk does not move
//    its group under you
//  - membership: a row shown under the current filter stays until the
//    filter changes, so a session that finishes (运行中) or is answered
//    (等你) does not vanish while you work through the list
// Re-tapping 会话 (the tab, or the sidebar entry while on it) or reloading
// re-reads both: resetSessionOrder.
import { useSyncExternalStore } from 'react'

import type { SessionCard } from './console-sessions'
import { visitOf, worktreeKey } from './session-order'

let seen = new Map<string, number>()
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

/** re-read visits and membership now (an explicit refresh) */
export function resetSessionOrder() {
  seen = new Map()
  shown = { filter: '', ids: new Set() }
  version += 1
  for (const listener of listeners) listener()
}

/** rows with `visited` pinned to the first visit seen (pass `{}` as phone on) */
export function useFrozenVisits(
  rows: Array<SessionCard>,
  phone: Record<string, number>,
): Array<SessionCard> {
  useVersion()
  return rows.map((row) => {
    const key = worktreeKey(row)
    let visit = seen.get(key)
    if (visit === undefined) {
      visit = visitOf(row, phone)
      seen.set(key, visit)
    }
    return { ...row, visited: visit }
  })
}

/** ids to list under `filter`: the matching ones plus those already shown */
export function useStickyMembers(filter: string, matching: Array<string>) {
  useVersion()
  if (shown.filter !== filter) shown = { filter, ids: new Set<string>() }
  for (const id of matching) shown.ids.add(id)
  return shown.ids
}
