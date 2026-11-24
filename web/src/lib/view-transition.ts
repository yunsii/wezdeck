// Page transitions: the browser's View Transitions through TanStack Router,
// in layers (styles/motion.css). The shell — status band, sidebar, tab bar — never
// moves. A section switch (sidebar / tab / palette) is instant, no
// transition at all: a view transition first snapshots the page, which only
// delays the switch, and the section's data is already warm (console-shell
// prefetch + the persisted cache). Within a section a phone pushes the new
// page in from the right (forward) and back (back); on a wide screen the
// split swaps its pane at once, no transition (it read as a flash).

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
  'inbox',
  'activity',
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

/** the split layout's breakpoint (useIsWide); false outside a browser */
const isWideNow = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(min-width: 768px)').matches

type Loc = { pathname: string; state?: { __TSR_index?: number } }
type ChangeInfo = { fromLocation?: Loc; toLocation: Loc; pathChanged: boolean }

/** first path segment under /console ('' = the index, a redirect to 会话) */
function sectionOf(pathname: string) {
  return (consolePath(pathname) ?? '')
    .replace(/^\/console\/?/, '')
    .split('/')[0]
}

/**
 * false = no transition (first load, only search / hash changed, leaving the
 * console, another section: sidebar, tabs, palette). Within one section (`within`, so a wide split keeps its
 * list still) the direction follows the history position first — returning
 * to an earlier entry is always "back" — and the depth only when the
 * position does not change.
 */
export function transitionTypes(
  { fromLocation, toLocation, pathChanged }: ChangeInfo,
  wide = isWideNow(),
): Array<string> | false {
  if (!fromLocation || !pathChanged) return false
  const from = routeRank(fromLocation.pathname)
  const to = routeRank(toLocation.pathname)
  if (from < 0 || to < 0) return false
  // another section (sidebar, tabs, palette): instant, whatever the depths
  if (sectionOf(fromLocation.pathname) !== sectionOf(toLocation.pathname))
    return false
  // a wide split: the list stays and the pane swaps at once — the fade
  // through blanked the pane for ~100 ms on every switch (a flash with j / k
  // and every click), and the snapshot held the re-render back meanwhile
  if (wide) return false
  if (from === to) return ['fade', 'within']
  const fromIndex = fromLocation.state?.__TSR_index
  const toIndex = toLocation.state?.__TSR_index
  const forward =
    fromIndex != null && toIndex != null && fromIndex !== toIndex
      ? toIndex > fromIndex
      : to > from
  return [forward ? 'forward' : 'back', 'within']
}

/**
 * Router scroll restoration, off on a detail page (a session, a ticket): the
 * router carries the previous page's offset onto a location it has no entry
 * for and applies it after render, so a switch in the wide split drew the
 * new conversation at the old one's offset — its middle — and the sticky
 * prompt flashed. A conversation lands at its bottom (chat-scroll), a
 * ticket at its top (tickets-view); lists keep restoration, so back on a
 * phone returns to the same place.
 */
export function restoresScroll(pathname: string) {
  const path = consolePath(pathname)
  return !(path && /^\/console\/(sessions|collab|inbox)\/[^/]+$/.test(path))
}
