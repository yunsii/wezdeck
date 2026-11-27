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
import { detailKey } from './session-detail-read'
import { LAST_SESSION_KEY, isSessionMissing } from './session-delete-state'
import { SessionList } from './session-list'
import { NewSessionGuidedView } from './session-new'
import { NewSessionJobView } from './session-new-job'
import {
  isNewSessionId,
  isVirtualSessionId,
  jobIdFromSessionId,
} from './session-new-route'
import { nextInCycle } from './session-order'
import { useSessionNav } from './session-switcher'
import { CopyKey, useCopySessionReference } from './copy-reference'

/** j / k: chat rows as the list paints them (one session id per workstation) */
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

/**
 * No session in the URL: the one last opened if it still exists, else the
 * top chat's focus session (lib/last-opened.ts). Status filters are gone.
 */
function usePickDefault(id: string | undefined) {
  const nav = useSessionNav(id ?? '')
  const client = useQueryClient()
  const navigate = useNavigate()
  const { locale } = useLocale()
  // Never re-pick a session whose detail query just reported "session not
  // found": a stale sessions list cache must not bounce back into
  // useLeaveMissingSession in an infinite loop.
  const alive = (sessionId: string) =>
    !isSessionMissing(
      sessionId,
      client.getQueryState(detailKey(sessionId))?.error,
    )
  const listed = nav.ordered.filter((row) => alive(row.id))
  const allAlive = nav.rows.filter((row) => alive(row.id))
  const pick = id
    ? {}
    : pickLast(
        LAST_SESSION_KEY,
        'all',
        listed.map((row) => row.id),
        allAlive.map((row) => row.id),
      )
  const chosen = useRef('')
  if (id) chosen.current = ''
  const target = id ? '' : chosen.current || (pick.id ?? listed.at(0)?.id ?? '')
  useEffect(() => {
    if (!target) return
    chosen.current = target
    void navigate({
      to: '/{-$locale}/console/sessions/$id',
      params: { locale: locale === 'en' ? undefined : locale, id: target },
      replace: true,
    })
  }, [target, navigate, locale])
}

/** j / k and the default pick: a desk's split only (a phone pushes pages) */
function DeskKeys({ id }: { id?: string }) {
  useListKeys(id ?? '')
  usePickDefault(id)
  const copyReference = useCopySessionReference()
  return (
    <CopyKey
      id={isVirtualSessionId(id) ? '' : (id ?? '')}
      copy={copyReference}
    />
  )
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
  // a switch in the split fades the new conversation in (it is already at
  // its bottom); the first one opened, or picked for you, just shows
  const first = useRef(id)
  first.current ??= id
  const switched = useRef(false)
  if (id && first.current && id !== first.current) switched.current = true
  return (
    <div className="max-md:contents md:grid md:grid-cols-[minmax(300px,360px)_minmax(0,1fr)] md:items-stretch">
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
        // the divider is the pane's left edge, top to bottom of the page;
        // the pane is at least the window tall, whatever the conversation's length
        className={cn(
          'vt-split-pane max-md:contents md:flex md:min-h-[100cqh] md:min-w-0 md:flex-col md:border-l md:border-brand-edge md:pl-[var(--page-x)]',
          !id && 'max-md:hidden',
        )}
        data-testid="session-pane"
      >
        {id ? (
          // keyed with the detail: it fades in as a whole on a switch;
          // flex like the pane, so the detail still fills its height
          <div
            key={id}
            data-testid="session-detail"
            className={cn(
              'max-md:contents md:flex md:min-w-0 md:flex-1 md:flex-col',
              wide && switched.current && 'pane-enter',
            )}
          >
            {isNewSessionId(id) ? (
              <NewSessionGuidedView />
            ) : jobIdFromSessionId(id) ? (
              <NewSessionJobView jobId={jobIdFromSessionId(id)!} />
            ) : (
              <SessionDetail id={id} />
            )}
          </div>
        ) : (
          <p className="rounded-2xl bg-brand-surface px-6 py-16 text-center text-caption text-brand-muted">
            {t`Pick a chat on the left. j / k move through the list.`}
          </p>
        )}
      </div>
    </div>
  )
}

export function ConsoleSessionsPage() {
  const { id } = useParams({ strict: false })
  const wide = useIsWidePhoneFirst()
  useEffect(() => {
    if (id && !isVirtualSessionId(id)) rememberOpened(LAST_SESSION_KEY, id)
  }, [id])
  return <SessionsLayout id={id} wide={wide} />
}
