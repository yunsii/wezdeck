// 会话 on a desk-sized window: the list on the left, the open conversation
// beside it (like 工单's inspector) — no trip back to the list to switch.
// The list is sticky with its own scroll; the conversation keeps the page
// scroll, so the chat's pin-to-bottom and jump-to-latest work unchanged.
// j / k move to the next / previous session in the list's order, the URL
// follows (replace). Opening 会话 with no session picked goes to the last one
// this browser opened (else the top of the list), so the pane is never an
// empty hint while sessions exist. A phone keeps list → pushed detail.
import { useLingui } from '@lingui/react/macro'
import { useNavigate, useParams } from '@tanstack/react-router'
import { useEffect } from 'react'

import { useLocale } from '#/lib/locale-context'
import { useIsWidePhoneFirst } from '#/lib/use-media'
import { SessionDetail } from './console-sessions'
import { SessionList } from './session-list'
import { nextInCycle } from './session-order'
import { useSessionNav } from './session-switcher'

function useListKeys(current: string) {
  const nav = useSessionNav(current)
  const ids = nav.ordered.map((row) => row.id)
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
      const next = nextInCycle(ids, current, event.key === 'j' ? 1 : -1)
      if (!next) return
      event.preventDefault()
      nav.go(next)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ids.join(' '), current, nav])
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
  return (
    <div className="grid grid-cols-[minmax(300px,360px)_minmax(0,1fr)] items-start gap-5">
      <aside
        aria-label={t`Agent sessions`}
        className="vt-split-list sticky top-4 max-h-[calc(100dvh-4.25rem)] overflow-y-auto pr-1"
      >
        <SessionList selected={id ?? ''} />
      </aside>
      <div
        className="vt-split-pane min-w-0 max-w-[900px]"
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
