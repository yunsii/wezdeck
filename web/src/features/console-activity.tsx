// 动态: the latest collab events as a timeline (newest first). Tool calls are
// the bulk of events; hidden by default, one toggle away.
import { useLingui } from '@lingui/react/macro'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'

import { getCollab } from '#/lib/runtime-client'
import { useLocale } from '#/lib/locale-context'
import { useAgo } from './tickets-view'

type Event = Record<string, unknown> & {
  seq?: number | null
  ticket?: string | null
  kind: string
  ts?: string | null
}

const WINDOW = 120

function useLatestEvents() {
  const client = useQueryClient()
  const key = ['runtime', 'collab', 'activity'] as const
  return useQuery({
    queryKey: key,
    enabled: typeof window !== 'undefined',
    refetchInterval: 20_000,
    queryFn: async () => {
      // events are paged forward from a sequence number: learn the head,
      // then read the last WINDOW events.
      const head = await getCollab('events', { limit: 1 })
      const after = Math.max(0, (head.ok ? head.head : 0) - WINDOW)
      const page = await getCollab('events', { after, limit: WINDOW })
      if (!page.ok) {
        if (client.getQueryData(key))
          throw new Error(page.error?.message ?? 'unavailable')
        return { ok: false as const, error: page.error?.message, events: [] }
      }
      return {
        ok: true as const,
        error: undefined,
        events: [...(page.events as Array<Event>)].reverse(),
      }
    },
  })
}

function useKindLabel() {
  const { t } = useLingui()
  const labels: Record<string, string> = {
    created: t`opened`,
    status: t`status`,
    run_start: t`run started`,
    run_end: t`run finished`,
    milestone: t`milestone`,
    checkout: t`checked out`,
    research_done: t`research done`,
    session_init: t`session started`,
    tool: t`tool call`,
    reply: t`reply`,
    closed: t`closed`,
    worktree_migrated: t`worktree migrated`,
    claimed: t`claimed`,
    challenged: t`challenged`,
  }
  return (kind: string) => labels[kind] ?? kind
}

function detailOf(event: Event) {
  const pick = ['title', 'status', 'repo', 'message', 'name', 'phase', 'tool']
  return pick
    .map((key) => event[key])
    .filter((value) => typeof value === 'string' && value)
    .slice(0, 2)
    .join(' · ')
}

export function ConsoleActivityPage() {
  const { t } = useLingui()
  const { locale } = useLocale()
  const localeParam = locale === 'en' ? undefined : locale
  const [showTools, setShowTools] = useState(false)
  const events = useLatestEvents()
  const ago = useAgo()
  const label = useKindLabel()
  const rows = (events.data?.events ?? []).filter(
    (event) => showTools || event.kind !== 'tool',
  )
  return (
    <div className="grid max-w-3xl content-start gap-3">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-base font-semibold">{t`Activity`}</h1>
        <label className="inline-flex min-h-10 items-center gap-2 text-xs text-brand-muted">
          <input
            type="checkbox"
            checked={showTools}
            onChange={(event) => setShowTools(event.target.checked)}
          />
          {t`Show tool calls`}
        </label>
      </div>
      {events.isError ? (
        <p role="status" className="text-xs text-brand-waiting">
          {t`Host unreachable right now`} · {t`showing the last copy`}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-brand-muted">
          {events.isPending
            ? t`Loading…`
            : (events.data?.error ?? t`No activity yet`)}
        </p>
      ) : (
        <ol
          aria-label={t`Collab activity`}
          className="-mx-4 divide-y divide-brand-border border-y border-brand-border md:mx-0 md:border"
        >
          {rows.map((event) => (
            <li
              key={`${event.seq ?? ''}-${event.kind}-${event.ts ?? ''}`}
              className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 px-4 py-2.5 text-sm"
            >
              <span className="font-medium text-brand-text">
                {label(event.kind)}
              </span>
              <span className="text-xs text-brand-label">{ago(event.ts)}</span>
              <span className="col-span-2 truncate text-xs text-brand-muted">
                {event.ticket ? (
                  <Link
                    to="/{-$locale}/console/collab/$id"
                    params={{ locale: localeParam, id: event.ticket }}
                    className="font-mono text-brand-running"
                  >
                    {event.ticket.slice(-6)}
                  </Link>
                ) : null}
                {event.ticket && detailOf(event) ? ' · ' : ''}
                {detailOf(event)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
