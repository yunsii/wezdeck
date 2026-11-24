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

import { idInUrl } from '#/lib/last-opened'
import { useLocale } from '#/lib/locale-context'
import { useIsWidePhoneFirst } from '#/lib/use-media'
import { SessionDetail, prefetchSession } from './console-sessions'
import { SessionList } from './session-list'
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

function lastSession() {
  try {
    return localStorage.getItem(LAST_KEY) ?? ''
  } catch {
    return ''
  }
}

function rememberSession(id: string) {
  try {
    localStorage.setItem(LAST_KEY, id)
  } catch {
    // blocked storage: the list's top session is the fallback
  }
}

/** no session in the URL: open the last one (still listed) or the top one */
function usePickDefault(id: string | undefined) {
  const nav = useSessionNav(id ?? '')
  const navigate = useNavigate()
  const { locale } = useLocale()
  const last = lastSession()
  const target = id
    ? ''
    : (nav.rows.find((row) => row.id === last)?.id ??
      nav.ordered.at(0)?.id ??
      '')
  useEffect(() => {
    if (!target) return
    // not nav.go: picking for you is not a visit, the list order stays
    void navigate({
      to: '/{-$locale}/console/sessions/$id',
      params: { locale: locale === 'en' ? undefined : locale, id: target },
      replace: true,
    })
  }, [target, navigate, locale])
}

function SplitView({ id }: { id?: string }) {
  const { t } = useLingui()
  useListKeys(id ?? '')
  usePickDefault(id)
  const copyReference = useCopySessionReference()
  return (
    <div className="grid grid-cols-[minmax(300px,360px)_minmax(0,1fr)] items-start">
      <CopyKey id={id ?? ''} copy={copyReference} />
      <SessionList selected={id ?? ''} split />
      <div
        // the divider is the pane's left edge, top to bottom of the page: the
        // pane steps over the page's own padding (-my-4 / py-4) and is at
        // least the window tall, whatever the conversation's length
        className="vt-split-pane -my-4 flex min-h-[100cqh] min-w-0 flex-col border-l border-brand-edge py-4 pl-[var(--page-x)]"
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
  useEffect(() => {
    if (id) rememberSession(id)
  }, [id])
  if (wide) return <SplitView id={id} />
  return id ? <SessionDetail id={id} /> : <SessionList />
}
