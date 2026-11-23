// 会话 on a desk-sized window: the list on the left, the open conversation
// beside it (like 工单's inspector) — no trip back to the list to switch.
// The list is sticky with its own scroll; the conversation keeps the page
// scroll, so the chat's pin-to-bottom and jump-to-latest work unchanged.
// j / k move to the next / previous session in the list's order, the URL
// follows (replace). A phone keeps list → pushed detail.
import { useLingui } from '@lingui/react/macro'
import { useParams } from '@tanstack/react-router'
import { useEffect } from 'react'

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

function SplitView({ id }: { id?: string }) {
  const { t } = useLingui()
  useListKeys(id ?? '')
  return (
    <div className="grid grid-cols-[minmax(300px,360px)_minmax(0,1fr)] items-start gap-5">
      <aside
        aria-label={t`Agent sessions`}
        className="sticky top-0 max-h-[calc(100dvh-6rem)] overflow-y-auto pr-1"
      >
        <SessionList selected={id ?? ''} />
      </aside>
      <div className="min-w-0 max-w-[900px]" data-testid="session-pane">
        {id ? (
          <SessionDetail key={id} id={id} />
        ) : (
          <p className="rounded-[16px] bg-brand-surface px-6 py-16 text-center text-sm text-brand-muted">
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
  if (wide) return <SplitView id={id} />
  return id ? <SessionDetail id={id} /> : <SessionList />
}
