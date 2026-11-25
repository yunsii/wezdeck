// Unsent text that survives leaving the page (this browser only), keyed by
// the caller: a session's composer, a ticket's reply box. Every write is
// broadcast, so another mounted copy of the same box (the page left and
// opened again while a send was still uploading) shows it too.
import { useCallback, useEffect, useRef, useState } from 'react'

const EVENT = 'wezdeck:draft'
type Change = { key: string; value: string; from: string }

function store(storageKey: string, value: string) {
  // idempotent, so a StrictMode double call is harmless
  try {
    if (value) localStorage.setItem(storageKey, value)
    else localStorage.removeItem(storageKey)
  } catch {
    // storage blocked or full
  }
}

/** tell the other mounted boxes; never from inside a state updater */
function announce(storageKey: string, value: string, from: string) {
  window.dispatchEvent(
    new CustomEvent<Change>(EVENT, {
      detail: { key: storageKey, value, from },
    }),
  )
}

function persist(storageKey: string, value: string, from: string) {
  store(storageKey, value)
  announce(storageKey, value, from)
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
  persist(storageKey, value, 'restore')
}

export function useDraft(storageKey: string) {
  const [text, setTextState] = useState('')
  // this box's own writes come back as events too: skip those
  const [self] = useState(() => Math.random().toString(36).slice(2))
  const unannounced = useRef(false)
  // load on mount / key change; writes happen only in setText, so a remount
  // (hydration) never wipes a stored draft with the empty initial state
  useEffect(() => {
    try {
      setTextState(localStorage.getItem(storageKey) ?? '')
    } catch {
      // storage blocked: drafts just don't persist
    }
    const onChange = (event: Event) => {
      const { key, value, from } = (event as CustomEvent<Change>).detail
      if (key === storageKey && from !== self) setTextState(value)
    }
    window.addEventListener(EVENT, onChange)
    return () => window.removeEventListener(EVENT, onChange)
  }, [storageKey, self])
  const setText = useCallback(
    (next: string | ((current: string) => string)) => {
      // a plain value is stored right away: an updater does not run once the
      // page is gone
      if (typeof next !== 'function') {
        persist(storageKey, next, self)
        setTextState(next)
        return
      }
      // an updater only computes and stores (StrictMode runs it twice); the
      // other boxes hear of it after the commit, not from inside it — an
      // event fired in there set state mid-update and doubled the text
      setTextState((current) => {
        const value = next(current)
        store(storageKey, value)
        return value
      })
      // the updater may run at the next render: announce once committed
      unannounced.current = true
    },
    [storageKey, self],
  )
  useEffect(() => {
    if (!unannounced.current) return
    unannounced.current = false
    announce(storageKey, text, self)
  }, [text, storageKey, self])
  return [text, setText] as const
}
