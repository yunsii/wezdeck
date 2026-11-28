// A row shown under the current filter stays until the filter changes, so a
// session that finishes (运行中) or is answered (等你) does not vanish mid-pass.
// Re-tapping 会话 (the tab, or the sidebar entry while on it) re-reads membership.
import { useSyncExternalStore } from 'react'

import type { ChatRepoGroup } from './session-chats'
import { flattenChats, stabilizeChatGroups } from './session-chats'

let shown = { filter: '', ids: new Set<string>() }
let chatOrder: Array<string> = []

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
  chatOrder = []
  version += 1
  for (const listener of listeners) listener()
}

/** Hold chat row order across detail -> list navigation and cache refreshes. */
export function useStableChatOrder(groups: Array<ChatRepoGroup>) {
  useVersion()
  const keys = flattenChats(groups).map(
    (chat) => `${chat.repoKey}\u0000${chat.key}`,
  )
  if (chatOrder.length === 0) {
    chatOrder = keys
    return groups
  }
  const known = new Set(chatOrder)
  chatOrder = [
    ...chatOrder.filter((key) => keys.includes(key)),
    ...keys.filter((key) => !known.has(key)),
  ]
  return stabilizeChatGroups(groups, chatOrder)
}

/** ids to list under `filter`: the matching ones plus those already shown */
export function useStickyMembers(filter: string, matching: Array<string>) {
  useVersion()
  if (shown.filter !== filter) shown = { filter, ids: new Set<string>() }
  for (const id of matching) shown.ids.add(id)
  return shown.ids
}
