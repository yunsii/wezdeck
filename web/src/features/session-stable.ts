// The session list holds still while you use it (session-list.tsx):
//  - order: each worktree's visit is read once, when the list first sees it,
//    so opening a session (a visit) or Alt+g at the desk no longer lifts its
//    group to the top under your cursor; leaving 会话 and coming back
//    re-reads them
//  - membership: a row shown under the current filter stays until the filter
//    changes or the list unmounts, so a session that finishes (运行中) or is
//    answered (等你) does not vanish while you look at it
import { useRef } from 'react'

import type { SessionCard } from './console-sessions'
import { visitOf, worktreeKey } from './session-order'

/** rows with `visited` pinned to the first visit seen (pass `{}` as phone on) */
export function useFrozenVisits(
  rows: Array<SessionCard>,
  phone: Record<string, number>,
): Array<SessionCard> {
  const seen = useRef(new Map<string, number>())
  return rows.map((row) => {
    const key = worktreeKey(row)
    let visit = seen.current.get(key)
    if (visit === undefined) {
      visit = visitOf(row, phone)
      seen.current.set(key, visit)
    }
    return { ...row, visited: visit }
  })
}

/** ids to list under `filter`: the matching ones plus those already shown */
export function useStickyMembers(filter: string, matching: Array<string>) {
  const shown = useRef({ filter, ids: new Set<string>() })
  if (shown.current.filter !== filter)
    shown.current = { filter, ids: new Set<string>() }
  for (const id of matching) shown.current.ids.add(id)
  return shown.current.ids
}
