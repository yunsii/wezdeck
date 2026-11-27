// The item a wide split last showed (会话 / 工单 / 待处理) and the status
// filter it was left on, per browser, best effort (blocked storage falls back
// to the list's first item). Opening the page with no item in the URL:
//   1. the item last opened under the current filter, if still listed there;
//   2. else the item last opened at all, if it still exists — the list
//      switches to 全部 to show it;
//   3. else the first item of the current list.
import { useEffect, useRef, useSyncExternalStore } from 'react'

export function lastOpened(key: string) {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // not remembered: the list's first item is the fallback
  }
}

/** record `id` as last opened, overall and under `filter` */
export function rememberOpened(scope: string, id: string, filter?: string) {
  if (!id) return
  store(scope, id)
  if (filter) store(`${scope}:${filter}`, id)
}

/** forget `id` when it no longer exists, so a wide split never bounces back to it */
export function forgetOpened(
  scope: string,
  id: string,
  filters: Array<string> = ['all'],
) {
  if (!id) return
  try {
    if (localStorage.getItem(scope) === id) localStorage.removeItem(scope)
    for (const filter of filters) {
      const key = `${scope}:${filter}`
      if (localStorage.getItem(key) === id) localStorage.removeItem(key)
    }
  } catch {
    // storage blocked
  }
}

/** renders nothing; records id (overall and under filter) when it changes */
export function RememberOpened({
  storageKey,
  id,
  filter,
}: {
  storageKey: string
  id: string
  filter?: string
}) {
  // on a new id only: switching the filter with one open must not file it
  // under the new filter (it overwrote that filter's own last)
  const filterNow = useRef(filter)
  filterNow.current = filter
  useEffect(() => {
    rememberOpened(storageKey, id, filterNow.current)
  }, [storageKey, id])
  return null
}

/**
 * Which item to open (rules 1–2 above); `all` = switch the list to 全部 to
 * show it. Nothing → the caller opens its list's first item.
 */
export function pickLast(
  scope: string,
  filter: string,
  shown: Array<string>,
  everything: Array<string>,
): { id?: string; all?: boolean } {
  const underFilter = lastOpened(`${scope}:${filter}`)
  if (underFilter && shown.includes(underFilter)) return { id: underFilter }
  const last = lastOpened(scope)
  if (last && shown.includes(last)) return { id: last }
  if (last && everything.includes(last)) return { id: last, all: true }
  return {}
}

// a choice (the status filter) shared by every component that reads it and
// kept per browser: the list and the split that picks for it agree
const choices = new Map<string, string>()
const choiceListeners = new Set<() => void>()

/** the choice now, read synchronously: for an effect or a pick that must not
 * depend on whether its component re-rendered (a hydrated route component
 * kept the server snapshot's value, and filed sessions under 全部) */
export function readStoredChoice<T extends string>(
  key: string,
  initial: T,
  valid: (value: string) => boolean,
): T {
  if (!choices.has(key)) {
    const saved = lastOpened(key)
    choices.set(key, saved && valid(saved) ? saved : initial)
  }
  return choices.get(key) as T
}

export function useStoredChoice<T extends string>(
  key: string,
  initial: T,
  valid: (value: string) => boolean,
): [T, (value: T) => void] {
  const value = useSyncExternalStore(
    (listener) => {
      choiceListeners.add(listener)
      return () => choiceListeners.delete(listener)
    },
    () => readStoredChoice(key, initial, valid),
    () => initial,
  )
  const set = (next: T) => {
    choices.set(key, next)
    store(key, next)
    for (const listener of choiceListeners) listener()
  }
  return [value, set]
}

/**
 * The id in the URL after `/console/<section>/`, read at a keypress: the URL
 * moves at once, the page re-renders only when the view transition ends, so
 * a j pressed in between used the previous item and went nowhere.
 */
export function idInUrl(section: string) {
  const match = new RegExp(`/console/${section}/([^/?#]+)`).exec(
    window.location.pathname,
  )
  return match ? decodeURIComponent(match[1]) : ''
}
