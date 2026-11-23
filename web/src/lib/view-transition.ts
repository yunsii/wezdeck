// Page transitions: the browser's View Transitions through TanStack Router,
// in layers (styles/motion.css). The shell — status band, sidebar, tab bar — never
// moves. A section switch (sidebar / tab / palette) is instant, no
// transition at all: a view transition first snapshots the page, which only
// delays the switch, and the section's data is already warm (console-shell
// prefetch + the persisted cache). Within a section a phone pushes the new
// page in from the right (forward) and back (back); on a wide screen the
// split list stays and only the pane beside it changes (within).

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
export function transitionTypes({
  fromLocation,
  toLocation,
  pathChanged,
}: ChangeInfo): Array<string> | false {
  if (!fromLocation || !pathChanged) return false
  const from = routeRank(fromLocation.pathname)
  const to = routeRank(toLocation.pathname)
  if (from < 0 || to < 0) return false
  // another section (sidebar, tabs, palette): instant, whatever the depths
  if (sectionOf(fromLocation.pathname) !== sectionOf(toLocation.pathname))
    return false
  if (from === to) return ['fade', 'within']
  const fromIndex = fromLocation.state?.__TSR_index
  const toIndex = toLocation.state?.__TSR_index
  const forward =
    fromIndex != null && toIndex != null && fromIndex !== toIndex
      ? toIndex > fromIndex
      : to > from
  return [forward ? 'forward' : 'back', 'within']
}
