// First-level pages (the bottom tabs and the desktop sidebar sections) only
// ever hold the FIRST history entry, the forge way (apps/web/src/lib/
// goToTab.ts, Android Navigation's popUpTo(start)): back on a first-level
// page leaves the app instead of stepping through earlier tabs or a stale
// entry. Going to one goes back to entry 0 in one step, then replaces it.
// A push would leave the deeper page behind it; a replace alone keeps every
// earlier entry (one more back press each).
import { useRouter } from '@tanstack/react-router'
import type { AnyRouter } from '@tanstack/react-router'

import { trace } from './client-trace'
import { isFirstLevel } from './view-transition'

const historyIndex = (router: AnyRouter) =>
  (router.history.location.state as { __TSR_index?: number }).__TSR_index ?? 0

/** back to the first entry, then make it `href` (unless it already is) */
function popToFirst(router: AnyRouter, href: string) {
  const replace = () => void router.navigate({ href, replace: true })
  const index = historyIndex(router)
  if (index <= 0) return replace()
  const unsubscribe = router.history.subscribe(() => {
    unsubscribe()
    const { pathname, search } = router.history.location
    if (pathname + search !== href) replace()
  })
  router.history.go(-index)
}

export function useGoToTab() {
  const router = useRouter()
  return (href: string) => popToFirst(router, href)
}

/**
 * Safety net: landing on a first-level page that is not the first entry
 * collapses it to the first one — entries an older build pushed (the tab's
 * history survives updates), in-page links to a section, a language switch.
 * Every navigation also leaves a `nav` row in the client trace (诊断).
 */
export function keepTabsFirst(router: AnyRouter) {
  if (typeof window === 'undefined') return
  let collapsing = false
  router.subscribe('onResolved', ({ toLocation }) => {
    trace('nav', {
      path: toLocation.pathname,
      index: historyIndex(router),
      length: history.length,
    })
    if (
      collapsing ||
      !isFirstLevel(toLocation.pathname) ||
      historyIndex(router) <= 0
    )
      return
    collapsing = true
    trace('nav-collapse', { from: historyIndex(router) })
    const unsubscribe = router.subscribe('onResolved', () => {
      if (historyIndex(router) > 0) return
      unsubscribe()
      collapsing = false
    })
    popToFirst(router, toLocation.href)
  })
}
