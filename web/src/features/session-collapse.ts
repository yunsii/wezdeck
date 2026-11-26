// A multi-session worktree row in the IM list can be folded back to its
// focus preview (session-chat-group.tsx). The choice is remembered per
// worktree, survives reloads, and is best-effort: without localStorage
// (private mode, unit tests) it lives in memory for the page's life.
import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'wezdeck-chat-collapse-v1'

/** stored shape: { [worktreeKey]: true } — only folded rows are recorded */
export function parseCollapsed(raw: string | null): Record<string, true> {
  const out: Record<string, true> = {}
  if (!raw) return out
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        if (value === true) out[key] = true
      }
    }
  } catch {
    // bad JSON: start empty rather than lose the list
  }
  return out
}

let store: Record<string, true> | undefined
let version = 0
const listeners = new Set<() => void>()

function load(): Record<string, true> {
  if (store) return store
  let raw: string | null = null
  try {
    // no localStorage outside a browser (unit tests): the throw is caught
    raw = globalThis.localStorage.getItem(STORAGE_KEY)
  } catch {
    // storage blocked: in-memory only
  }
  store = parseCollapsed(raw)
  return store
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const getVersion = () => version

export function setChatCollapsed(key: string, value: boolean) {
  const all = load()
  if (value) all[key] = true
  else delete all[key]
  version += 1
  for (const listener of listeners) listener()
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
  } catch {
    // storage blocked: the in-memory choice still holds for this page
  }
}

/** folded state of one worktree row + its toggle (expanded by default) */
export function useChatCollapsed(key: string): [boolean, () => void] {
  useSyncExternalStore(subscribe, getVersion, getVersion)
  const collapsed = Boolean(load()[key])
  return [collapsed, () => setChatCollapsed(key, !collapsed)]
}
