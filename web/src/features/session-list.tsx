// 会话 left rail as an IM chat list (Telegram Web orientation): one row per
// workstation, repo as a quiet section head, unread = waiting or done-unseen.
// A workstation with several sessions becomes a foldable header plus one
// stable sub-row per session (session-chat-group) — no focus repaint, every
// session directly reachable. No status Segmented. Opening a single-session
// row resolves the focus session (session-chats) and navigates to
// /sessions/$id. Order: unread first within a repo, then activity time —
// frozen while you work (session-stable).
import { ContextMenu } from '@base-ui/react/context-menu'
import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { CheckCheck, FolderGit2, Hash, Plus, Search, X } from 'lucide-react'
import { useMemo, useState } from 'react'

import { StickyBar } from '#/components/deck/sticky-bar'
import { SplitColumn } from '#/components/deck/split-column'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { AgentAvatar, agentLabel } from './agent-avatar'
import { WorktreePurpose } from './session-purpose'
import { hasEditableGroupName } from './session-order'
import { ChatGroupRow } from './session-chat-group'
import { useLocale } from '#/lib/locale-context'
import { consoleVisits, recordVisit } from '#/lib/session-visits'
import { useIsWide } from '#/lib/use-media'
import { cn } from '#/lib/utils'
import { NOT_PAIRED } from '#/lib/remote-link'
import { OpenTodos } from './session-todos'
import { SessionListSkeleton } from './session-skeleton'
import { clearable, useClearSession } from './session-clear'
import { useDeleteSession } from './session-delete'
import { useDeviceState } from './device-state'
import { NewSessionButton, requestNewSession } from './session-new'
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
import { useFrozenVisits, useStickyMembers } from './session-stable'
import { useCopySessionReference } from './copy-reference'
import { SwipeActions } from './session-row-swipe'
import { prefetchSession, useSessions } from './console-sessions'
import type { SessionCard } from './console-sessions'
import { readDraft, sessionDraftKey, useDraftRevision } from '#/lib/use-draft'

const menuItemClass =
  'flex cursor-default items-center gap-2 rounded-lg px-3 py-2 outline-none data-[highlighted]:bg-brand-soft'

function useChatPreviewLabels() {
  const { t } = useLingui()
  return {
    waiting: t`Waiting on you`,
    needsConfirm: t`Needs a decision`,
    done: t`Done`,
    working: t`Working`,
    empty: t`No human message yet`,
    draft: t`Draft`,
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
  selectedId,
  replace,
  preview,
  timeLabel,
}: {
  chat: SessionChat
  selectedId?: string
  replace: boolean
  preview: string
  timeLabel: string
}) {
  const { t } = useLingui()
  const { locale } = useLocale()
  const localeParam = locale === 'en' ? undefined : locale
  const device = useDeviceState()
  const copyReference = useCopySessionReference()
  const { clear } = useClearSession()
  const client = useQueryClient()
  const row = chat.focus
  const tone = chatTone(row)
  const warm = () => prefetchSession(client, row.id)
  const selected = row.id === selectedId
  const canClear =
    device.state === 'approved' && clearable(row.status, row.waiting_kind)
  const deleteSession = useDeleteSession()
  const canManage = device.state === 'approved' && Boolean(row.tmux_pane)
  const copy = () => copyReference(row.id)
  return (
    <SwipeActions
      id={row.id}
      left={{
        label: t`Copy reference`,
        className: 'bg-brand-soft text-brand-text',
        testId: 'chat-swipe-copy',
        onAction: copy,
      }}
      right={
        canClear
          ? {
              label: t`Mark read`,
              busyLabel: t`Clearing…`,
              className: 'bg-brand-done text-white',
              testId: 'chat-swipe-mark-read',
              onAction: () => clear(row.id),
            }
          : undefined
      }
    >
      <ContextMenu.Root>
        <ContextMenu.Trigger
          data-testid="chat-row-menu"
          className={cn(
            'group/row relative block w-full select-none outline-none [-webkit-touch-callout:none]',
            'data-[popup-open]:bg-brand-soft',
          )}
        >
          <Link
            to="/{-$locale}/console/sessions/$id"
            params={{ locale: localeParam, id: row.id }}
            data-session={row.id}
            data-chat={chat.key}
            replace={replace}
            aria-current={selected ? 'page' : undefined}
            onClick={() => recordVisit(chat.key)}
            onPointerEnter={warm}
            onPointerDown={warm}
            onFocus={warm}
            className={cn(
              'list-row flex min-h-14 items-start gap-3 px-4 py-2.5 md:px-[var(--split-pad)]',
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
                <span
                  className={cn(
                    'min-w-0 truncate text-title',
                    chat.unread > 0 ? 'font-semibold' : 'font-medium',
                  )}
                >
                  {row.title?.trim() ||
                    agentLabel(row.agent, row.agent_profile)}
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {chat.unread > 0 ? (
                    <span
                      data-testid="chat-unread"
                      data-tone={tone}
                      className={cn(
                        'inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-meta font-semibold',
                        tone === 'done'
                          ? 'bg-brand-done text-[#0b1a12]'
                          : 'bg-brand-waiting text-[#1b1406]',
                      )}
                    >
                      {chat.unread}
                    </span>
                  ) : null}
                  <span className="text-meta text-brand-label">
                    {timeLabel}
                  </span>
                </span>
              </span>
              <span
                data-testid="chat-preview"
                data-tone={tone}
                className={cn(
                  'truncate text-caption',
                  tone === 'waiting' && 'text-brand-waiting',
                  tone === 'done' && 'text-brand-done',
                  tone === 'running' && 'text-brand-running',
                  tone === 'idle' && 'text-brand-muted',
                )}
              >
                {preview}
              </span>
            </span>
          </Link>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Positioner className="z-[60]">
            <ContextMenu.Popup
              data-deck
              data-testid="chat-row-context-menu"
              className="motion-pop min-w-44 rounded-xl border border-brand-edge bg-brand-surface p-1 text-body text-brand-text shadow-lg outline-none"
            >
              <ContextMenu.Item
                data-testid="chat-row-copy-reference"
                onClick={() => void copy()}
                className={menuItemClass}
              >
                <Hash size={14} aria-hidden />
                {t`Copy reference`}
              </ContextMenu.Item>
              {canManage ? (
                <>
                  <ContextMenu.Item
                    className={menuItemClass}
                    onClick={() =>
                      requestNewSession({
                        repo: chat.repoKey,
                        anchor: row.id,
                        group: chat.purpose || chat.title,
                      })
                    }
                  >
                    <Plus size={14} aria-hidden />
                    {t`New session in this group`}
                  </ContextMenu.Item>
                  <ContextMenu.Item
                    className={menuItemClass}
                    onClick={() => void deleteSession(row, selected)}
                  >
                    {t`Delete session`}
                  </ContextMenu.Item>
                </>
              ) : null}
              {canClear ? (
                <ContextMenu.Item
                  data-testid="chat-row-mark-read"
                  onClick={() => void clear(row.id)}
                  className={menuItemClass}
                >
                  <CheckCheck size={14} aria-hidden />
                  {t`Mark read`}
                </ContextMenu.Item>
              ) : null}
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    </SwipeActions>
  )
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
  useDraftRevision()
  const rowsWithDrafts = rows.map((row) => ({
    ...row,
    draft: readDraft(sessionDraftKey(row.id)),
  }))
  const groups = buildChatGroups(rowsWithDrafts, phone)
  const previewLabels = useChatPreviewLabels()
  const timeOf = useChatTimeLabel()
  const [query, setQuery] = useState('')
  const wide = useIsWide()

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
            return b.visit - a.visit || a.title.localeCompare(b.title)
          })
        return { ...repo, chats }
      })
      .filter((repo) => repo.chats.length > 0)
  }, [groups, query, keptUnread, previewLabels])

  const replaceSession = wide && rows.some((row) => row.id === selected)
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
          className={cn(
            'border-l-[3px] border-brand-waiting bg-brand-waiting/10 px-3 py-3 text-caption break-words',
            split &&
              'border-b border-b-brand-edge pl-[calc(var(--split-pad)-3px)] pr-[var(--split-pad)]',
          )}
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
          className="grid grid-cols-[minmax(0,1fr)] gap-3 md:gap-0"
          data-testid="session-chats"
        >
          {painted.map((repo) => (
            <section
              key={repo.key}
              className="overflow-hidden rounded-2xl bg-brand-surface md:rounded-none"
              data-repo={repo.label}
            >
              <h2 className="flex items-center gap-1.5 border-b border-brand-edge px-4 py-2 text-caption font-medium text-brand-label md:px-[var(--split-pad)]">
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
                    {chat.sessions.length > 1 ? (
                      <ChatGroupRow
                        chat={chat}
                        selectedId={selected}
                        replace={replaceSession}
                        timeOf={timeOf}
                      />
                    ) : (
                      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center">
                        <ChatRow
                          chat={chat}
                          selectedId={selected}
                          replace={replaceSession}
                          preview={previewOf(chat)}
                          timeLabel={timeOf(chat.focus.ts)}
                        />
                        <WorktreePurpose
                          compact
                          worktree={chat.key}
                          description={chat.purpose}
                          editable={hasEditableGroupName(chat.focus)}
                        />
                      </div>
                    )}
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
      {/* No -mx bleed: bled sticky made the search row look inset while the
          surface cards (skeleton especially) read as full-bleed against a
          near-white deck. Keep sticky and cards on the same content width. */}
      <StickyBar className="mx-0 px-0">{headActions}</StickyBar>
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
