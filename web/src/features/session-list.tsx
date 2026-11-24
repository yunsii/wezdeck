// 会话, the phone's home: every live agent session as a repo → worktree →
// pane tree. Order follows where you went — the later of the desk visit
// (access ledger, like Alt+g) and a visit from this phone — never agent
// output, so the list holds still while agents work. Sessions waiting on you
// sit in a band on top; the filter mirrors Alt+/ (Tab cycles the status).
import { useLingui } from '@lingui/react/macro'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'

import { Led } from '#/components/deck/led'
import { Segmented } from '#/components/deck/segmented'
import { useLocale } from '#/lib/locale-context'
import { phoneVisits, recordVisit } from '#/lib/session-visits'
import { useIsWide } from '#/lib/use-media'
import { cn } from '#/lib/utils'
import { NOT_PAIRED } from '#/lib/remote-link'
import { OpenTodos } from './session-todos'
import { clearable, SwipeToClear } from './session-clear'
import { NewSessionButton } from './session-new'
import {
  buildSessionTree,
  repoName,
  visitOf,
  worktreeKey,
} from './session-order'
import { useAgo } from './tickets-view'
import {
  humanPrompt,
  isBusy,
  needsYou,
  sessionTone,
  useSessions,
  useStatusText,
} from './console-sessions'
import type { SessionCard } from './console-sessions'

export type SessionFilter = 'all' | 'waiting' | 'running' | 'idle'

// wrapped, not `waiting: needsYou`: console-sessions imports this module, so
// its exports are not initialised yet while this object is built
const FILTERS: Record<SessionFilter, (row: SessionCard) => boolean> = {
  all: () => true,
  waiting: (row) => needsYou(row),
  running: (row) => !needsYou(row) && isBusy(row),
  idle: (row) => !needsYou(row) && !isBusy(row),
}

const FILTER_KEY = 'wezdeck-session-filter'

function storedFilter(): SessionFilter {
  try {
    const value = localStorage.getItem(FILTER_KEY)
    return value && value in FILTERS ? (value as SessionFilter) : 'all'
  } catch {
    return 'all'
  }
}

const ts = (iso?: number) => (iso ? new Date(iso).toISOString() : undefined)

/** one session in the list; beside the open session (wide split) picking
 * another replaces the history entry */
function SessionRow({
  row,
  selected,
  showRepo = false,
}: {
  row: SessionCard
  selected?: string
  showRepo?: boolean
}) {
  const { t } = useLingui()
  const { locale } = useLocale()
  const localeParam = locale === 'en' ? undefined : locale
  const ago = useAgo()
  const statusText = useStatusText()
  const wide = useIsWide()
  const paneLabel = (role?: string) =>
    role === 'primary' ? t`Primary` : role === 'secondary' ? t`Secondary` : ''

  const title =
    row.title ||
    row.worktree?.split('/').filter(Boolean).at(-1) ||
    row.cwd.split('/').filter(Boolean).at(-1) ||
    row.id.slice(0, 8)

  const tag = (text: string) => (
    <span
      title={text}
      className="max-w-full min-w-0 truncate rounded-full bg-brand-deck px-1.5 py-0.5 text-meta text-brand-label"
    >
      {text}
    </span>
  )

  const prompt = humanPrompt(row.last_prompt)
  const status = statusText(
    row.status,
    row.waiting_kind,
    row.running_kind,
    row.background?.length ?? 0,
  )
  return (
    <SwipeToClear id={row.id} enabled={clearable(row.status, row.waiting_kind)}>
      <Link
        to="/{-$locale}/console/sessions/$id"
        params={{ locale: localeParam, id: row.id }}
        data-session={row.id}
        data-pane-role={row.pane_role || undefined}
        replace={wide && Boolean(selected)}
        aria-current={row.id === selected ? 'page' : undefined}
        onClick={() => recordVisit(worktreeKey(row))}
        className={cn(
          'key-press flex min-h-14 items-start gap-3 px-4 py-3',
          // the selected row as in 工单 / 诊断: page tone + accent bar
          row.id === selected &&
            'bg-brand-deck shadow-[inset_3px_0_0_var(--brand-running)]',
        )}
      >
        <span className="pt-1.5">
          <Led tone={sessionTone(row.status, row.waiting_kind)} size={12} />
        </span>
        <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] gap-0.5">
          <span className="flex items-baseline justify-between gap-2">
            <span className="truncate text-title font-medium">{title}</span>
            <span className="shrink-0 text-meta text-brand-label">
              {ago(ts(row.ts))}
            </span>
          </span>
          <span className="truncate text-caption text-brand-muted">
            {prompt || t`No human message yet`}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-1">
            {showRepo && repoName(row) ? tag(repoName(row)) : null}
            {row.pane_role ? tag(paneLabel(row.pane_role)) : null}
            {row.agent && row.agent !== 'agent' ? tag(row.agent) : null}
            {status ? tag(status) : null}
            {row.branch ? tag(row.branch) : null}
          </span>
        </span>
      </Link>
    </SwipeToClear>
  )
}

export function SessionList({ selected }: { selected?: string } = {}) {
  const { t } = useLingui()
  const sessions = useSessions()
  const [filter, setFilterState] = useState<SessionFilter>(storedFilter)
  const setFilter = (value: SessionFilter) => {
    setFilterState(value)
    try {
      localStorage.setItem(FILTER_KEY, value)
    } catch {
      // the choice just won't be remembered
    }
  }
  const rows = sessions.data?.sessions ?? []
  const phone = phoneVisits()
  const waiting = rows
    .filter(needsYou)
    .sort((a, b) => visitOf(b, phone) - visitOf(a, phone))
  // 全部: the waiting band on top, the tree holds the rest
  const treeRows =
    filter === 'all'
      ? rows.filter((row) => !needsYou(row))
      : rows.filter(FILTERS[filter])
  const tree = buildSessionTree(treeRows, phone)
  const count = (value: SessionFilter) => rows.filter(FILTERS[value]).length
  const waitingCount = count('waiting')
  const runningCount = count('running')
  const idleCount = count('idle')
  const allCount = rows.length
  const emptyText =
    filter === 'waiting'
      ? t`Nothing is waiting on you.`
      : filter === 'running'
        ? t`No agent is working right now.`
        : filter === 'idle'
          ? t`No idle sessions.`
          : t`No agent sessions are running.`

  return (
    <div className="grid max-w-2xl grid-cols-[minmax(0,1fr)] content-start gap-3">
      <h1 className="hidden text-body font-semibold md:block">
        {t({ message: 'Sessions', context: 'nav' })}
      </h1>
      <div className="flex items-center gap-2">
        <Segmented
          label={t`Status`}
          value={filter}
          onChange={setFilter}
          className="min-w-0 flex-1 md:max-w-md"
          dense
          options={[
            {
              value: 'all',
              label: t({ message: 'All', context: 'filter' }),
              count: allCount,
            },
            {
              value: 'waiting',
              label: t({ message: 'Needs you', context: 'filter' }),
              count: waitingCount,
            },
            {
              value: 'running',
              label: t({ message: 'Working', context: 'filter' }),
              count: runningCount,
            },
            {
              value: 'idle',
              label: t({ message: 'Idle', context: 'filter' }),
              count: idleCount,
            },
          ]}
        />
        <NewSessionButton />
      </div>
      {sessions.isError ? (
        <p
          role="status"
          className="rounded-xl bg-brand-waiting/10 px-3 py-2 text-body"
        >
          {sessions.error.message === NOT_PAIRED
            ? t`Sessions come over the remote link, and this device is not paired yet. On the host run scripts/dev/install-remote-relay.sh --pair and open the link here.`
            : String(sessions.error.message)}
        </p>
      ) : null}
      {filter === 'all' && waiting.length ? (
        <section
          data-testid="sessions-waiting"
          className="overflow-hidden rounded-2xl border border-brand-waiting/40 bg-brand-surface"
        >
          <h2 className="border-b border-brand-edge px-4 py-2 text-caption font-medium text-brand-label">
            {t`Needs you`}
          </h2>
          <ul>
            {waiting.map((row) => (
              <li
                key={row.id}
                className="border-b border-brand-edge last:border-b-0"
              >
                <SessionRow row={row} selected={selected} showRepo />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {tree.length === 0 && !(filter === 'all' && waiting.length) ? (
        sessions.isError ? null : (
          <p className="rounded-xl bg-brand-surface px-4 py-10 text-center text-caption text-brand-muted">
            {sessions.isPending ? t`Loading…` : emptyText}
          </p>
        )
      ) : (
        <div
          aria-label={t`Agent sessions`}
          className="grid grid-cols-[minmax(0,1fr)] gap-3"
        >
          {tree.map((repo) => (
            <section
              key={repo.key}
              className="overflow-hidden rounded-2xl bg-brand-surface"
              data-repo={repo.label}
            >
              <h2 className="border-b border-brand-edge px-4 py-2 text-caption font-medium text-brand-label">
                {repo.label}
              </h2>
              {repo.worktrees.map((wt) => {
                const showWt =
                  repo.worktrees.length > 1 || wt.label !== repo.label
                return (
                  <div key={wt.key} data-worktree={wt.label}>
                    {showWt ? (
                      <p className="border-b border-brand-edge px-4 py-1.5 text-meta text-brand-label">
                        {wt.label}
                      </p>
                    ) : null}
                    <ul>
                      {wt.rows.map((row) => (
                        <li
                          key={row.id}
                          className="border-b border-brand-edge last:border-b-0"
                        >
                          <SessionRow row={row} selected={selected} />
                        </li>
                      ))}
                    </ul>
                  </div>
                )
              })}
            </section>
          ))}
        </div>
      )}
      {filter === 'all' ? <OpenTodos /> : null}
    </div>
  )
}
