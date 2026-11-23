// Unsent text that survives leaving the page (this browser only), keyed by
// the caller: a session's composer, a ticket's reply box.
import { useCallback, useEffect, useState } from 'react'

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
  }, [storageKey])
  const setText = useCallback(
    (next: string | ((current: string) => string)) => {
      setTextState((current) => {
        const value = typeof next === 'function' ? next(current) : next
        // idempotent, so a StrictMode double call is harmless
        try {
          if (value) localStorage.setItem(storageKey, value)
          else localStorage.removeItem(storageKey)
        } catch {
          // storage blocked or full
        }
        return value
      })
    },
    [storageKey],
  )
  return [text, setText] as const
}
