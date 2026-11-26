// 会话 left rail as an IM chat list (Telegram Web orientation): one row per
// workstation, repo as a quiet section head, unread = needs-you badge. No
// status Segmented. Opening a row resolves the focus session (session-chats)
// and navigates to /sessions/$id. Order: unread first within a repo, then
// activity time — frozen while you work (session-stable).
import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { FolderGit2, Plus } from 'lucide-react'
import type { SyntheticEvent } from 'react'

import { Led } from '#/components/deck/led'
import { StickyBar } from '#/components/deck/sticky-bar'
import { SplitColumn } from '#/components/deck/split-column'
import { Button } from '#/components/ui/button'
import { useLocale } from '#/lib/locale-context'
import { consoleVisits, recordVisit } from '#/lib/session-visits'
import { useIsWide } from '#/lib/use-media'
import { cn } from '#/lib/utils'
import { NOT_PAIRED } from '#/lib/remote-link'
import { OpenTodos } from './session-todos'
import { SessionListSkeleton } from './session-skeleton'
import { clearable, SwipeToClear } from './session-clear'
import { NewSessionButton, requestNewSession } from './session-new'
import { WorktreePurpose } from './session-purpose'
import { worktreeKey } from './session-order'
import { buildChatGroups, flattenChats } from './session-chats'
import type { SessionChat } from './session-chats'
import { directionForWorktree, useDirections } from './session-new-direction'
import { useFrozenVisits, useStickyMembers } from './session-stable'
import { useAgo } from './tickets-view'
import { RowCopyButton, useCopySessionReference } from './copy-reference'
import {
  humanPrompt,
  needsYou,
  prefetchSession,
  sessionTone,
  useSessions,
} from './console-sessions'
import type { SessionCard } from './console-sessions'

const ts = (iso?: number) => (iso ? new Date(iso).toISOString() : undefined)

function ChatRow({
  chat,
  selectedWorktree,
}: {
  chat: SessionChat
  selectedWorktree?: string
}) {
  const { t } = useLingui()
  const { locale } = useLocale()
  const localeParam = locale === 'en' ? undefined : locale
  const ago = useAgo()
  const wide = useIsWide()
  const copyReference = useCopySessionReference()
  const client = useQueryClient()
  const directions = useDirections(chat.repoKey)
  const row = chat.focus
  const warm = () => prefetchSession(client, row.id)
  const prompt = humanPrompt(row.last_prompt)
  const selected = Boolean(selectedWorktree && selectedWorktree === chat.key)
  const newRound = (event: SyntheticEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const direction = directionForWorktree(
      directions.data?.directions ?? [],
      chat.key,
      chat.title,
    )
    if (!direction) return
    requestNewSession({ repo: chat.repoKey, direction })
  }
  return (
    <SwipeToClear id={row.id} enabled={clearable(row.status, row.waiting_kind)}>
      <div className="group/row relative">
        <Link
          to="/{-$locale}/console/sessions/$id"
          params={{ locale: localeParam, id: row.id }}
          data-session={row.id}
          data-chat={chat.key}
          replace={wide && Boolean(selectedWorktree)}
          aria-current={selected ? 'page' : undefined}
          onClick={() => recordVisit(chat.key)}
          onPointerEnter={warm}
          onPointerDown={warm}
          onFocus={warm}
          className={cn(
            'list-row flex min-h-14 items-start gap-3 px-4 py-3 pr-14',
            selected && 'row-selected',
          )}
        >
          <span className="pt-1.5">
            <Led
              tone={
                chat.unread
                  ? 'waiting'
                  : sessionTone(row.status, row.waiting_kind)
              }
              size={12}
            />
          </span>
          <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] gap-0.5">
            <span className="flex items-baseline justify-between gap-2">
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="truncate text-title font-medium">
                  {chat.title}
                </span>
                {chat.editable || chat.purpose ? (
                  <WorktreePurpose
                    worktree={chat.key}
                    description={chat.purpose}
                    editable={chat.editable}
                  />
                ) : null}
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                {chat.unread > 0 ? (
                  <span
                    data-testid="chat-unread"
                    className="inline-flex min-w-5 items-center justify-center rounded-full bg-brand-waiting px-1.5 text-meta font-semibold text-[#1b1406]"
                  >
                    {chat.unread}
                  </span>
                ) : null}
                <span className="text-meta text-brand-label">
                  {ago(ts(row.ts))}
                </span>
              </span>
            </span>
            <span className="truncate text-caption text-brand-muted">
              {prompt || t`No human message yet`}
            </span>
          </span>
        </Link>
        {chat.editable ? (
          <Button
            variant="plain"
            size="none"
            type="button"
            data-testid="chat-new-round"
            title={t`New round`}
            aria-label={t`New round`}
            onClick={newRound}
            onPointerDown={(event) => event.stopPropagation()}
            className="absolute top-2 right-2 inline-flex size-9 items-center justify-center rounded-full text-brand-muted opacity-0 outline-none group-hover/row:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-brand-running max-md:opacity-70"
          >
            <Plus size={16} aria-hidden />
          </Button>
        ) : null}
        <RowCopyButton id={row.id} copy={copyReference} />
      </div>
    </SwipeToClear>
  )
}

/** worktree of the open session — left-rail selection follows the chat */
export function selectedChatKey(
  selected: string | undefined,
  rows: Array<SessionCard>,
) {
  if (!selected) return undefined
  const row = rows.find((r) => r.id === selected)
  return row ? worktreeKey(row) : undefined
}

export function SessionList({
  selected,
  split = false,
}: { selected?: string; split?: boolean } = {}) {
  const { t } = useLingui()
  const sessions = useSessions()
  const phone = consoleVisits()
  const rows = useFrozenVisits(sessions.data?.sessions ?? [], phone)
  const groups = buildChatGroups(rows, phone)
  // unread set sticky: clearing one does not reshuffle the rest mid-pass
  const unreadKeys = flattenChats(groups)
    .filter((c) => c.unread > 0)
    .map((c) => c.key)
  const keptUnread = useStickyMembers('chats-unread', unreadKeys)
  const painted = groups.map((repo) => ({
    ...repo,
    chats: [...repo.chats].sort((a, b) => {
      const au = keptUnread.has(a.key) || a.unread > 0 ? 1 : 0
      const bu = keptUnread.has(b.key) || b.unread > 0 ? 1 : 0
      if (au !== bu) return bu - au
      return b.activity - a.activity || b.visit - a.visit
    }),
  }))
  const selectedWorktree = selectedChatKey(selected, rows)
  const empty = painted.every((repo) => repo.chats.length === 0)

  const title = (
    <h1 className="hidden text-body font-semibold md:block">
      {t({ message: 'Sessions', context: 'nav' })}
    </h1>
  )
  const headActions = (
    <div className="flex items-center justify-end gap-2">
      {split ? null : title}
      <div className="flex-1" />
      <NewSessionButton />
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
      {empty ? (
        sessions.isError ? null : sessions.isPending ? (
          <SessionListSkeleton />
        ) : (
          <p className="rounded-xl bg-brand-surface px-4 py-10 text-center text-caption text-brand-muted">
            {t`No agent sessions are running.`}
          </p>
        )
      ) : (
        <div
          aria-label={t`Agent sessions`}
          className="grid grid-cols-[minmax(0,1fr)] gap-3"
          data-testid="session-chats"
        >
          {painted.map((repo) => (
            <section
              key={repo.key}
              className="overflow-hidden rounded-2xl bg-brand-surface"
              data-repo={repo.label}
            >
              <h2 className="flex items-center gap-1.5 border-b border-brand-edge px-4 py-2 text-caption font-medium text-brand-label">
                <FolderGit2 size={14} aria-hidden className="shrink-0" />
                {repo.label}
              </h2>
              <ul>
                {repo.chats.map((chat) => (
                  <li
                    key={chat.key}
                    className="border-b border-brand-edge last:border-b-0"
                    data-worktree={chat.title}
                  >
                    <ChatRow chat={chat} selectedWorktree={selectedWorktree} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      <OpenTodos />
    </>
  )
  if (split)
    return (
      <SplitColumn
        label={t`Agent sessions`}
        head={
          <div className="flex items-center justify-between gap-2">
            {title}
            <NewSessionButton />
          </div>
        }
      >
        {body}
      </SplitColumn>
    )
  return (
    <div className="grid max-w-2xl grid-cols-[minmax(0,1fr)] content-start gap-3">
      <StickyBar>{headActions}</StickyBar>
      {body}
    </div>
  )
}

// Legacy exports: wide split / remember-opened used a status filter. The IM
// list has no filter; callers that still import these get a no-op "all".
export type SessionFilter = 'all'
export const SESSION_FILTERS: Record<
  SessionFilter,
  (row: SessionCard) => boolean
> = { all: () => true }
export const useSessionFilter = (): [
  SessionFilter,
  (value: SessionFilter) => void,
] => ['all', () => {}]
export const readSessionFilter = (): SessionFilter => 'all'

// re-export for switcher / tests that counted waiting sessions
export { needsYou }
