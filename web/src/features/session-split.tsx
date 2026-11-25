// 会话 on a desk-sized window: the list on the left, the open conversation
// beside it (like 工单's inspector) — no trip back to the list to switch.
// The list is sticky with its own scroll; the conversation keeps the page
// scroll, so the chat's pin-to-bottom and jump-to-latest work unchanged.
// j / k move to the next / previous session as the list shows it (its
// filter and held order), the URL follows (replace). Opening 会话 with no session picked goes to the last one
// this browser opened (else the top of the list), so the pane is never an
// empty hint while sessions exist. A phone keeps list → pushed detail.
import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'

import { cn } from '#/lib/utils'

import { idInUrl, pickLast, rememberOpened } from '#/lib/last-opened'
import { useLocale } from '#/lib/locale-context'
import { useIsWidePhoneFirst } from '#/lib/use-media'
import { SessionDetail, prefetchSession } from './console-sessions'
import {
  SESSION_FILTERS,
  SessionList,
  readSessionFilter,
  useSessionFilter,
} from './session-list'
import { nextInCycle } from './session-order'
import { useSessionNav } from './session-switcher'
import { CopyKey, useCopySessionReference } from './copy-reference'

/** j / k: the rows as the list shows them — its filter and its held order */
function listedIds() {
  return Array.from(
    document.querySelectorAll<HTMLElement>('.vt-split-list [data-session]'),
    (el) => el.dataset.session ?? '',
  ).filter(Boolean)
}

function useListKeys(current: string) {
  const nav = useSessionNav(current)
  const client = useQueryClient()
  // j / k's next stops, warmed once the list shows: no Loading… frame
  useEffect(() => {
    const ids = listedIds()
    for (const step of [1, -1]) {
      const next = nextInCycle(ids, current, step)
      if (next) prefetchSession(client, next)
    }
  }, [current, client])
  // read at the keypress, not captured: the URL first (idInUrl), since the
  // page re-renders only after the switch's view transition
  const now = useRef({ current, nav })
  now.current = { current, nav }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        (event.key !== 'j' && event.key !== 'k') ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.closest('input, textarea, select, [contenteditable="true"]')
      )
        return
      const next = nextInCycle(
        listedIds(),
        idInUrl('sessions') || now.current.current,
        event.key === 'j' ? 1 : -1,
      )
      if (!next) return
      event.preventDefault()
      now.current.nav.go(next)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

const LAST_KEY = 'wezdeck-last-session'

/**
 * No session in the URL: the one last opened under the current filter, else
 * the one last opened at all if it still exists (the list switches to 全部
 * to show it), else the top of the current list (lib/last-opened.ts).
 */
function usePickDefault(id: string | undefined) {
  const nav = useSessionNav(id ?? '')
  const navigate = useNavigate()
  const { locale } = useLocale()
  const [, setFilter] = useSessionFilter()
  const filter = readSessionFilter()
  const listed = nav.ordered.filter(SESSION_FILTERS[filter])
  const pick = id
    ? {}
    : pickLast(
        LAST_KEY,
        filter,
        listed.map((row) => row.id),
        nav.rows.map((row) => row.id),
      )
  // chosen once per visit with no id: switching to 全部 re-renders before
  // the navigation lands, and a re-pick took 全部's own last instead
  const chosen = useRef('')
  if (id) chosen.current = ''
  const target = id
    ? ''
    : chosen.current ||
      (pick.id ?? listed.at(0)?.id ?? nav.ordered.at(0)?.id ?? '')
  const toAll = Boolean(pick.all) && filter !== 'all'
  useEffect(() => {
    if (!target) return
    chosen.current = target
    if (toAll) setFilter('all')
    // not nav.go: picking for you is not a visit, the list order stays
    void navigate({
      to: '/{-$locale}/console/sessions/$id',
      params: { locale: locale === 'en' ? undefined : locale, id: target },
      replace: true,
    })
    // setFilter is a fresh closure each render; target / toAll decide
  }, [target, toAll, navigate, locale])
}

/** j / k and the default pick: a desk's split only (a phone pushes pages) */
function DeskKeys({ id }: { id?: string }) {
  useListKeys(id ?? '')
  usePickDefault(id)
  const copyReference = useCopySessionReference()
  return <CopyKey id={id ?? ''} copy={copyReference} />
}

/**
 * One tree for every width, laid out by CSS: on a desk the list column and
 * the conversation side by side; on a phone the list alone, or the open
 * conversation alone (the other column hidden). The server paints it before
 * any script knows the width — it used to paint the phone tree and swap in
 * the split after hydration, so a refresh on a desk showed the conversation
 * without its list until then. The list's own split look and the desk-only
 * keys still wait for the measured width (phone first: no flash on phones).
 */
function SessionsLayout({ id, wide }: { id?: string; wide: boolean }) {
  const { t } = useLingui()
  return (
    <div className="max-md:contents md:grid md:grid-cols-[minmax(300px,360px)_minmax(0,1fr)] md:items-start">
      {wide ? <DeskKeys id={id} /> : null}
      <div
        data-testid="session-list-column"
        // as tall as the row (the whole conversation): the list inside is
        // sticky, and sticky stays within its parent — a list-high wrapper
        // let a long conversation's page scroll carry the list away
        className={cn('max-md:contents md:self-stretch', id && 'max-md:hidden')}
      >
        <SessionList selected={id ?? ''} split={wide} />
      </div>
      <div
        // the divider is the pane's left edge, top to bottom of the page: the
        // pane steps over the page's own padding (-my-4 / py-4) and is at
        // least the window tall, whatever the conversation's length
        className={cn(
          'vt-split-pane max-md:contents md:-my-4 md:flex md:min-h-[100cqh] md:min-w-0 md:flex-col md:border-l md:border-brand-edge md:py-4 md:pl-[var(--page-x)]',
          !id && 'max-md:hidden',
        )}
        data-testid="session-pane"
      >
        {id ? (
          <SessionDetail key={id} id={id} />
        ) : (
          <p className="rounded-2xl bg-brand-surface px-6 py-16 text-center text-caption text-brand-muted">
            {t`Pick a session on the left. j / k move through the list.`}
          </p>
        )}
      </div>
    </div>
  )
}

export function ConsoleSessionsPage() {
  const { id } = useParams({ strict: false })
  const wide = useIsWidePhoneFirst()
  // on opening a session only (switching the filter with one open must not
  // file it under the new filter), with the filter read now
  useEffect(() => {
    if (id) rememberOpened(LAST_KEY, id, readSessionFilter())
  }, [id])
  return <SessionsLayout id={id} wide={wide} />
}
