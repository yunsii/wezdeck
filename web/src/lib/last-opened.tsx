// The item a wide split last showed (工单 / 待处理), so opening the page with
// none in the URL shows it again instead of the top of the list — the same
// rule as 会话 (session-split.tsx). Per browser, best effort: blocked storage
// just falls back to the list's first item.
import { useEffect } from 'react'

export function lastOpened(key: string) {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

/** renders nothing; records id under key whenever it changes */
export function RememberOpened({
  storageKey,
  id,
}: {
  storageKey: string
  id: string
}) {
  useEffect(() => {
    if (!id) return
    try {
      localStorage.setItem(storageKey, id)
    } catch {
      // not remembered: the list's first item is the fallback
    }
  }, [storageKey, id])
  return null
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
