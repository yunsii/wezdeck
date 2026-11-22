// Page transitions, the forge way (apps/web/src/lib/viewTransition.ts): the
// browser's View Transitions through TanStack Router. Going deeper pushes in
// from the right (forward), going back slides back from the left (back),
// pages of the same depth cross-fade, and the bottom tabs slide in their
// left-to-right order while the tab bar itself stays put (styles.css).

/** console path without the locale prefix, or null outside the console */
export function consolePath(pathname: string): string | null {
  const path = pathname.replace(/^\/zh(?=\/|$)/, '') || '/'
  return /^\/console(\/|$)/.test(path) ? path.replace(/\/$/, '') : null
}

/** first-level pages, in the phone tab order first, then desktop-only ones */
const FIRST_LEVEL = [
  'sessions',
  'collab',
  'me',
  '',
  'inbox',
  'activity',
  'development',
  'diagnostics',
]

/** ones digit = tab order, tens = depth; -1 outside the console */
export function routeRank(pathname: string): number {
  const path = consolePath(pathname)
  if (path === null) return -1
  const rest = path.replace(/^\/console\/?/, '')
  const at = FIRST_LEVEL.indexOf(rest)
  return at >= 0 ? at : 10
}

export const isFirstLevel = (pathname: string) => {
  const rank = routeRank(pathname)
  return rank >= 0 && rank < 10
}

type Loc = { pathname: string; state?: { __TSR_index?: number } }
type ChangeInfo = { fromLocation?: Loc; toLocation: Loc; pathChanged: boolean }

/**
 * false = no transition (first load, only search / hash changed, leaving the
 * console). Direction follows the history position first — returning to an
 * earlier entry is always "back" — and the depth only when the position does
 * not change (tab switches replace).
 */
export function transitionTypes({
  fromLocation,
  toLocation,
  pathChanged,
}: ChangeInfo): Array<string> | false {
  if (!fromLocation || !pathChanged) return false
  const from = routeRank(fromLocation.pathname)
  const to = routeRank(toLocation.pathname)
  if (from < 0 || to < 0) return false
  if (from === to) return ['fade']
  const fromIndex = fromLocation.state?.__TSR_index
  const toIndex = toLocation.state?.__TSR_index
  const forward =
    fromIndex != null && toIndex != null && fromIndex !== toIndex
      ? toIndex > fromIndex
      : to > from
  const types = [forward ? 'forward' : 'back']
  if (from < 10 && to < 10) types.push('tabs')
  return types
}
