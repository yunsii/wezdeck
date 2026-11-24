// Unsent text that survives leaving the page (this browser only), keyed by
// the caller: a session's composer, a ticket's reply box. Every write is
// broadcast, so another mounted copy of the same box (the page left and
// opened again while a send was still uploading) shows it too.
import { useCallback, useEffect, useState } from 'react'

const EVENT = 'wezdeck:draft'
type Change = { key: string; value: string }

function persist(storageKey: string, value: string) {
  // idempotent, so a StrictMode double call is harmless
  try {
    if (value) localStorage.setItem(storageKey, value)
    else localStorage.removeItem(storageKey)
  } catch {
    // storage blocked or full
  }
  window.dispatchEvent(
    new CustomEvent<Change>(EVENT, { detail: { key: storageKey, value } }),
  )
}

/**
 * Put text back after a failed send unless something new was typed since
 * (works with the page gone: it writes storage, not component state).
 */
export function restoreDraft(storageKey: string, value: string) {
  try {
    if (localStorage.getItem(storageKey)) return
  } catch {
    // storage blocked: still tell a mounted box
  }
  persist(storageKey, value)
}

export function useDraft(storageKey: string) {
  const [text, setTextState] = useState('')
  // load on mount / key change; writes happen only in setText, so a remount
  // (hydration) never wipes a stored draft with the empty initial state
  useEffect(() => {
    try {
      setTextState(localStorage.getItem(storageKey) ?? '')
    } catch {
      // storage blocked: drafts just don't persist
    }
    const onChange = (event: Event) => {
      const { key, value } = (event as CustomEvent<Change>).detail
      if (key === storageKey) setTextState(value)
    }
    window.addEventListener(EVENT, onChange)
    return () => window.removeEventListener(EVENT, onChange)
  }, [storageKey])
  const setText = useCallback(
    (next: string | ((current: string) => string)) => {
      // a plain value is stored right away: an updater does not run once the
      // page is gone
      if (typeof next !== 'function') persist(storageKey, next)
      setTextState((current) => {
        if (typeof next !== 'function') return next
        const value = next(current)
        persist(storageKey, value)
        return value
      })
    },
    [storageKey],
  )
  return [text, setText] as const
}
