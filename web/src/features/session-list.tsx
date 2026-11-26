// 会话 left rail as an IM chat list (Telegram Web orientation): one row per
// workstation, repo as a quiet section head, unread = needs-you badge. No
// status Segmented. Opening a row resolves the focus session (session-chats)
// and navigates to /sessions/$id. Order: unread first within a repo, then
// activity time — frozen while you work (session-stable).
import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { FolderGit2, Plus, Search, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { SyntheticEvent } from 'react'

import { StickyBar } from '#/components/deck/sticky-bar'
import { SplitColumn } from '#/components/deck/split-column'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { AgentAvatar } from './agent-avatar'
import { useLocale } from '#/lib/locale-context'
import { consoleVisits, recordVisit } from '#/lib/session-visits'
import { useIsWide } from '#/lib/use-media'
import { cn } from '#/lib/utils'
import { NOT_PAIRED } from '#/lib/remote-link'
import { OpenTodos } from './session-todos'
import { SessionListSkeleton } from './session-skeleton'
import { clearable, SwipeToClear } from './session-clear'
import { NewSessionButton, requestNewSession } from './session-new'
import { worktreeKey } from './session-order'
import {
  buildChatGroups,
  chatMatchesQuery,
  chatPreview,
  chatTone,
  flattenChats,
} from './session-chats'
import type { SessionChat } from './session-chats'
import {
  chatTimeBucket,
  formatChatClock,
  formatChatDate,
  formatChatWeekday,
} from './chat-time'
import { directionForWorktree, useDirections } from './session-new-direction'
import { useFrozenVisits, useStickyMembers } from './session-stable'
import { RowCopyButton, useCopySessionReference } from './copy-reference'
import { prefetchSession, useSessions } from './console-sessions'
import type { SessionCard } from './console-sessions'

function useChatPreviewLabels() {
  const { t } = useLingui()
  return {
    waiting: t`Waiting on you`,
    needsConfirm: t`Needs a decision`,
    working: t`Replying…`,
    empty: t`No human message yet`,
  }
}

function useChatTimeLabel() {
  const { t } = useLingui()
  const { locale } = useLocale()
  return (ms?: number) => {
    if (!ms) return ''
    const bucket = chatTimeBucket(ms)
    if (bucket === 'today') return formatChatClock(ms, locale)
    if (bucket === 'yesterday') return t`Yesterday`
    if (bucket === 'weekday') return formatChatWeekday(ms, locale)
    return formatChatDate(ms, locale)
  }
}

function ChatRow({
  chat,
  selectedWorktree,
  preview,
  timeLabel,
}: {
  chat: SessionChat
  selectedWorktree?: string
  preview: string
  timeLabel: string
}) {
  const { t } = useLingui()
  const { locale } = useLocale()
  const localeParam = locale === 'en' ? undefined : locale
  const wide = useIsWide()
  const copyReference = useCopySessionReference()
  const client = useQueryClient()
  const directions = useDirections(chat.repoKey)
  const row = chat.focus
  const tone = chatTone(row)
  const warm = () => prefetchSession(client, row.id)
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
            'list-row flex min-h-14 items-start gap-3 px-4 py-2.5 pr-14',
            selected && 'row-selected',
          )}
        >
          <AgentAvatar
            agent={row.agent}
            profile={row.agent_profile}
            size={40}
            tone={tone}
            className="mt-0.5"
          />
          <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] gap-0.5">
            <span className="flex items-baseline justify-between gap-2">
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span
                  className={cn(
                    'truncate text-title',
                    chat.unread > 0 ? 'font-semibold' : 'font-medium',
                  )}
                >
                  {chat.title}
                </span>
                {chat.purpose ? (
                  <span
                    className="min-w-0 truncate text-brand-muted"
                    data-testid="worktree-description"
                    title={chat.purpose}
                  >
                    · {chat.purpose}
                  </span>
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
                <span className="text-meta text-brand-label">{timeLabel}</span>
              </span>
            </span>
            <span
              data-testid="chat-preview"
              data-tone={tone}
              className={cn(
                'truncate text-caption',
                tone === 'waiting' && 'text-brand-waiting',
                tone === 'running' && 'text-brand-running',
                tone === 'idle' && 'text-brand-muted',
              )}
            >
              {preview}
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

function ChatSearch({
  value,
  onChange,
}: {
  value: string
  onChange: (next: string) => void
}) {
  const { t } = useLingui()
  return (
    <label className="relative min-w-0 flex-1">
      <Search
        size={16}
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-brand-label"
      />
      <Input
        variant="field"
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t`Search sessions`}
        aria-label={t`Search sessions`}
        data-testid="chat-search"
        className="h-9 min-h-9 w-full pl-8 pr-8 text-caption"
      />
      {value ? (
        <Button
          type="button"
          variant="plain"
          size="none"
          aria-label={t`Clear search`}
          onClick={() => onChange('')}
          className="absolute top-1/2 right-1 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-brand-muted"
        >
          <X size={14} aria-hidden />
        </Button>
      ) : null}
    </label>
  )
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
  const previewLabels = useChatPreviewLabels()
  const timeOf = useChatTimeLabel()
  const [query, setQuery] = useState('')

  const previewOf = (chat: SessionChat) =>
    chatPreview(chat.focus, previewLabels)

  // unread set sticky: clearing one does not reshuffle the rest mid-pass
  const unreadKeys = flattenChats(groups)
    .filter((c) => c.unread > 0)
    .map((c) => c.key)
  const keptUnread = useStickyMembers('chats-unread', unreadKeys)

  const painted = useMemo(() => {
    return groups
      .map((repo) => {
        const chats = repo.chats
          .filter((chat) =>
            chatMatchesQuery(
              chat,
              query,
              chatPreview(chat.focus, previewLabels),
            ),
          )
          .sort((a, b) => {
            const au = keptUnread.has(a.key) || a.unread > 0 ? 1 : 0
            const bu = keptUnread.has(b.key) || b.unread > 0 ? 1 : 0
            if (au !== bu) return bu - au
            return b.activity - a.activity || b.visit - a.visit
          })
        return { ...repo, chats }
      })
      .filter((repo) => repo.chats.length > 0)
  }, [groups, query, keptUnread, previewLabels])

  const selectedWorktree = selectedChatKey(selected, rows)
  const empty = painted.every((repo) => repo.chats.length === 0)
  const searching = query.trim().length > 0

  const title = (
    <h1 className="hidden text-body font-semibold md:block">
      {t({ message: 'Sessions', context: 'nav' })}
    </h1>
  )
  const headActions = (
    <div className="flex min-w-0 items-center gap-2">
      {split ? null : title}
      <ChatSearch value={query} onChange={setQuery} />
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
        ) : searching ? (
          <div className="rounded-xl bg-brand-surface px-4 py-10 text-center">
            <p className="text-caption text-brand-muted">
              {t`No sessions match that search.`}
            </p>
            <Button
              type="button"
              variant="plain"
              className="mt-3 min-h-11 px-3 text-caption text-brand-running"
              onClick={() => setQuery('')}
            >
              {t`Clear search`}
            </Button>
          </div>
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
                    <ChatRow
                      chat={chat}
                      selectedWorktree={selectedWorktree}
                      preview={previewOf(chat)}
                      timeLabel={timeOf(chat.focus.ts)}
                    />
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
          <div className="flex min-w-0 items-center gap-2">
            {title}
            <ChatSearch value={query} onChange={setQuery} />
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
export { needsYou } from './console-sessions'
