// 会话, the phone's home: every live agent session as a repo → worktree →
// pane tree. Order follows where you went — the later of the desk visit
// (access ledger, like Alt+g) and a visit from this phone — never agent
// output, so the list holds still while agents work. Sessions waiting on you
// sit in a band on top; the filter mirrors Alt+/ (Tab cycles the status).
import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { FolderGit2, GitFork } from 'lucide-react'

import { Led } from '#/components/deck/led'
import { Segmented } from '#/components/deck/segmented'
import {
  AgentTag,
  BranchTag,
  RepoTag,
  RoleTag,
  StatusTag,
} from '#/components/deck/session-tags'
import { StickyBar } from '#/components/deck/sticky-bar'
import { SplitColumn } from '#/components/deck/split-column'
import { readStoredChoice, useStoredChoice } from '#/lib/last-opened'
import { useLocale } from '#/lib/locale-context'
import { consoleVisits, recordVisit } from '#/lib/session-visits'
import { useIsWide } from '#/lib/use-media'
import { cn } from '#/lib/utils'
import { NOT_PAIRED } from '#/lib/remote-link'
import { OpenTodos } from './session-todos'
import { SessionListSkeleton } from './session-skeleton'
import { clearable, SwipeToClear } from './session-clear'
import { NewSessionButton } from './session-new'
import {
  buildSessionTree,
  inRunning,
  repoName,
  visitOf,
  worktreeKey,
} from './session-order'
import { useFrozenVisits, useStickyMembers } from './session-stable'
import { useAgo } from './tickets-view'
import { RowCopyButton, useCopySessionReference } from './copy-reference'
import {
  humanPrompt,
  needsYou,
  prefetchSession,
  sessionTone,
  useSessions,
  useStatusText,
} from './console-sessions'
import type { SessionCard } from './console-sessions'

export type SessionFilter = 'all' | 'waiting' | 'running' | 'idle'

// wrapped, not `waiting: needsYou`: console-sessions imports this module, so
// its exports are not initialised yet while this object is built
export const SESSION_FILTERS: Record<
  SessionFilter,
  (row: SessionCard) => boolean
> = {
  all: () => true,
  waiting: (row) => needsYou(row),
  // a turn that just ended stays 运行中 for a few minutes (inRunning)
  running: (row) => inRunning(row, Date.now()),
  idle: (row) => !needsYou(row) && !inRunning(row, Date.now()),
}

const FILTER_KEY = 'wezdeck-session-filter'
const validFilter = (value: string) => value in SESSION_FILTERS

/** the status filter, shared with the split (it picks for this list) */
export const useSessionFilter = () =>
  useStoredChoice<SessionFilter>(FILTER_KEY, 'all', validFilter)

/** the filter now, for an effect / a pick (readStoredChoice) */
export const readSessionFilter = () =>
  readStoredChoice<SessionFilter>(FILTER_KEY, 'all', validFilter)

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
  const copyReference = useCopySessionReference()
  const client = useQueryClient()
  const warm = () => prefetchSession(client, row.id)
  const paneLabel = (role?: string) =>
    role === 'primary' ? t`Primary` : role === 'secondary' ? t`Secondary` : ''

  // untitled until the agent names it (or a /clear dropped the old name)
  const title = row.title || t`Untitled session`

  const prompt = humanPrompt(row.last_prompt)
  const status = statusText(
    row.status,
    row.waiting_kind,
    row.running_kind,
    row.background?.length ?? 0,
  )
  return (
    <SwipeToClear id={row.id} enabled={clearable(row.status, row.waiting_kind)}>
      {/* the copy key sits beside the link (no button inside an a) */}
      <div className="group/row relative">
        <Link
          to="/{-$locale}/console/sessions/$id"
          params={{ locale: localeParam, id: row.id }}
          data-session={row.id}
          data-pane-role={row.pane_role || undefined}
          replace={wide && Boolean(selected)}
          aria-current={row.id === selected ? 'page' : undefined}
          onClick={() => recordVisit(worktreeKey(row))}
          // warm it before it opens: no Loading… frame between two sessions
          onPointerEnter={warm}
          onPointerDown={warm}
          onFocus={warm}
          className={cn(
            'list-row flex min-h-14 items-start gap-3 px-4 py-3',
            // the selected row as in 工单 / 诊断 (.row-selected, deck.css)
            row.id === selected && 'row-selected',
          )}
        >
          <span className="pt-1.5">
            <Led tone={sessionTone(row.status, row.waiting_kind)} size={12} />
          </span>
          <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] gap-0.5">
            <span className="flex items-baseline justify-between gap-2">
              <span
                className={cn(
                  'truncate text-title font-medium',
                  !row.title && 'text-brand-label',
                )}
              >
                {title}
              </span>
              <span className="shrink-0 text-meta text-brand-label">
                {ago(ts(row.ts))}
              </span>
            </span>
            <span className="truncate text-caption text-brand-muted">
              {prompt || t`No human message yet`}
            </span>
            <span className="flex min-w-0 flex-wrap items-center gap-1">
              {showRepo && repoName(row) ? (
                <RepoTag repo={repoName(row)} />
              ) : null}
              {row.pane_role ? (
                <RoleTag
                  role={row.pane_role}
                  label={paneLabel(row.pane_role)}
                />
              ) : null}
              {row.agent && row.agent !== 'agent' ? (
                <AgentTag agent={row.agent} />
              ) : null}
              {status ? (
                <StatusTag
                  tone={sessionTone(row.status, row.waiting_kind)}
                  label={status}
                />
              ) : null}
              {row.branch ? <BranchTag branch={row.branch} /> : null}
            </span>
          </span>
        </Link>
        <RowCopyButton id={row.id} copy={copyReference} />
      </div>
    </SwipeToClear>
  )
}

/** split: the wide list column — title and filter in a fixed head (SplitColumn) */
export function SessionList({
  selected,
  split = false,
}: { selected?: string; split?: boolean } = {}) {
  const { t } = useLingui()
  const sessions = useSessions()
  const [filter, setFilter] = useSessionFilter()
  // visits pinned once seen and rows kept once shown (session-stable.ts):
  // the list does not reshuffle or empty itself while you work through it
  const rows = useFrozenVisits(sessions.data?.sessions ?? [], consoleVisits())
  const waiting = rows
    .filter(needsYou)
    .sort((a, b) => visitOf(b, {}) - visitOf(a, {}))
  const kept = useStickyMembers(
    filter,
    rows.filter(SESSION_FILTERS[filter]).map((row) => row.id),
  )
  // 全部: the waiting band on top, the tree holds the rest
  const treeRows =
    filter === 'all'
      ? rows.filter((row) => !needsYou(row))
      : rows.filter((row) => kept.has(row.id))
  const tree = buildSessionTree(treeRows, {})
  const count = (value: SessionFilter) =>
    rows.filter(SESSION_FILTERS[value]).length
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

  const title = (
    <h1 className="hidden text-body font-semibold md:block">
      {t({ message: 'Sessions', context: 'nav' })}
    </h1>
  )
  const filterRow = (
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
      {/* wide: the button sits on the title row (more room for the filter) */}
      {split ? null : <NewSessionButton />}
    </div>
  )
  const body = (
    <>
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
        sessions.isError ? null : sessions.isPending ? (
          <SessionListSkeleton />
        ) : (
          <p className="rounded-xl bg-brand-surface px-4 py-10 text-center text-caption text-brand-muted">
            {emptyText}
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
              {/* repo: a git folder; worktree: a fork of that checkout */}
              <h2 className="flex items-center gap-1.5 border-b border-brand-edge px-4 py-2 text-caption font-medium text-brand-label">
                <FolderGit2 size={14} aria-hidden className="shrink-0" />
                {repo.label}
              </h2>
              {repo.worktrees.map((wt) => {
                const showWt =
                  repo.worktrees.length > 1 || wt.label !== repo.label
                return (
                  <div key={wt.key} data-worktree={wt.label}>
                    {showWt ? (
                      <p className="flex items-center gap-1.5 border-b border-brand-edge py-1.5 pr-4 pl-5 text-meta text-brand-label">
                        <GitFork size={12} aria-hidden className="shrink-0" />
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
    </>
  )
  if (split)
    return (
      <SplitColumn
        label={t`Agent sessions`}
        head={
          <>
            <div className="flex items-center justify-between gap-2">
              {title}
              <NewSessionButton />
            </div>
            {filterRow}
          </>
        }
      >
        {body}
      </SplitColumn>
    )
  return (
    <div className="grid max-w-2xl grid-cols-[minmax(0,1fr)] content-start gap-3">
      {title}
      <StickyBar>{filterRow}</StickyBar>
      {body}
    </div>
  )
}
