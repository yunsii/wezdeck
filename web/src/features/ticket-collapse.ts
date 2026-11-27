// Best-effort per-parent expand/collapse state for folded parent-child ticket
// groups (mirrors session-collapse.ts).
import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'wezdeck-ticket-expand-v1'

function parseMap(raw: string | null): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  if (!raw) return out
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'boolean') out[k] = v
      }
    }
  } catch {
    // bad JSON: start empty
  }
  return out
}

let store: Record<string, boolean> | undefined
let version = 0
const listeners = new Set<() => void>()

function load(): Record<string, boolean> {
  if (store) return store
  let raw: string | null = null
  try {
    raw = globalThis.localStorage.getItem(STORAGE_KEY)
  } catch {
    // storage blocked
  }
  store = parseMap(raw)
  return store
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const getVersion = () => version

export function setTicketGroupExpanded(parentId: string, expanded: boolean) {
  const all = load()
  all[parentId] = expanded
  version += 1
  for (const listener of listeners) listener()
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
  } catch {
    // storage blocked
  }
}

export function useTicketExpandedMap(): Readonly<Record<string, boolean>> {
  useSyncExternalStore(subscribe, getVersion, getVersion)
  return load()
}
