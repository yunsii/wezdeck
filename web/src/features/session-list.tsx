// 会话 left rail as an IM chat list (Telegram Web orientation): one row per
// workstation, repo as a quiet section head, unread = waiting or done-unseen.
// A workstation with several sessions becomes a foldable header plus one
// stable sub-row per session (session-chat-group) — no focus repaint, every
// session directly reachable. No status Segmented. Opening a single-session
// row resolves the focus session (session-chats) and navigates to
// /sessions/$id. Order: unread first within a repo, then activity time —
// frozen while you work (session-stable).
import { useLingui } from '@lingui/react/macro'
import { Link } from '@tanstack/react-router'
import { Search, X } from 'lucide-react'
import { useMemo, useState } from 'react'

import { AgentAvatar, agentLabel } from './agent-avatar'
import { StickyBar } from '#/components/deck/sticky-bar'
import { SplitColumn } from '#/components/deck/split-column'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { cn } from '#/lib/utils'
import { ChatGroupRow } from './session-chat-group'
import { ChatRow } from './session-chat-row'
import { useLocale } from '#/lib/locale-context'
import { useIsWide } from '#/lib/use-media'
import { NOT_PAIRED } from '#/lib/remote-link'
import { RepoLinksSheet, RepoSectionHeader } from './repo-links'
import type { RepoLinksTarget } from './repo-links'
import { SessionListSkeleton } from './session-skeleton'
import { NewSessionButton } from './session-new'
import { useStageText } from './session-new-panels'
import { isVirtualSessionId, jobSessionId } from './session-new-route'
import type { NewSessionJob } from './session-new-route'
import {
  buildChatGroups,
  chatMatchesQuery,
  chatPreview,
  flattenChats,
} from './session-chats'
import type { SessionChat } from './session-chats'
import {
  chatTimeBucket,
  formatChatClock,
  formatChatDate,
  formatChatWeekday,
} from './chat-time'
import { useStableChatOrder, useStickyMembers } from './session-stable'
import { useSessionListTrace } from './session-list-trace'
import { useSessions } from './console-sessions'
import type { SessionCard } from './console-sessions'
import { useReplyPreviews } from './session-reply-preview'
import { readDraft, sessionDraftKey, useDraftRevision } from '#/lib/use-draft'

function useChatPreviewLabels() {
  const { t } = useLingui()
  return {
    waiting: t`Waiting on you`,
    needsConfirm: t`Needs a decision`,
    done: t`Done`,
    working: t`Working`,
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
        data-search
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

function CreatingSessionsList({
  jobs,
  selected,
  replace,
  timeOf,
}: {
  jobs: Array<NewSessionJob>
  selected?: string
  replace: boolean
  timeOf: (ms?: number) => string
}) {
  const { t } = useLingui()
  const { locale } = useLocale()
  const localeParam = locale === 'en' ? undefined : locale
  const stageText = useStageText()
  if (jobs.length === 0) return null
  return (
    <section
      data-testid="creating-sessions"
      aria-label={t`Creating sessions`}
      className="border-b border-brand-edge bg-brand-surface"
    >
      <ul className="chat-list">
        {jobs.map((job) => {
          const virtualId = jobSessionId(job.job)
          const active = selected === virtualId
          const tone =
            job.stage === 'failed'
              ? 'error'
              : job.stage === 'waiting_trust'
                ? 'waiting'
                : 'running'
          const title =
            job.group_name ||
            job.repo_label ||
            job.repo?.split('/').pop() ||
            t`New session`
          const status = stageText({
            stage: job.stage,
            branch: job.branch,
            error: job.error,
            mode: job.mode,
          })
          return (
            <li key={job.job} data-creating-job={job.job}>
              <Link
                to="/{-$locale}/console/sessions/$id"
                params={{ locale: localeParam, id: virtualId }}
                replace={replace}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'list-row flex min-h-16 items-center gap-3 px-3 py-2',
                  active && 'row-selected',
                )}
              >
                <AgentAvatar
                  profile={job.agent_profile}
                  size={40}
                  tone={tone}
                />
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-body font-semibold text-brand-text">
                      {title} · {agentLabel('', job.agent_profile)}
                    </span>
                    {job.created_at ? (
                      <span className="shrink-0 text-meta text-brand-label tabular-nums">
                        {timeOf(job.created_at)}
                      </span>
                    ) : null}
                  </span>
                  <span className="truncate text-caption leading-5 text-brand-muted">
                    {job.prompt ? `${status} · ${job.prompt}` : status}
                  </span>
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function SessionList({
  selected,
  split = false,
}: { selected?: string; split?: boolean } = {}) {
  const { t } = useLingui()
  const sessions = useSessions()
  const rows = sessions.data?.sessions ?? []
  const rowsWithReplies = useReplyPreviews(rows)
  const creatingJobs = sessions.data?.creating_jobs ?? []
  useDraftRevision()
  // Keep the raw trimmed draft on each row so sub-rows can preserve their
  // compact/two-line height when selected; each row hides its Draft pill on
  // the active item via visibleDraft().
  const rowsWithDrafts = rowsWithReplies.map((row) => ({
    ...row,
    draft: readDraft(sessionDraftKey(row.id)).trim(),
  }))
  const groups = useStableChatOrder(buildChatGroups(rowsWithDrafts))
  const previewLabels = useChatPreviewLabels()
  const timeOf = useChatTimeLabel()
  const [query, setQuery] = useState('')
  const [linksTarget, setLinksTarget] = useState<RepoLinksTarget | null>(null)
  const [linksOpen, setLinksOpen] = useState(false)
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
            return b.activity - a.activity || a.title.localeCompare(b.title)
          })
        return { ...repo, chats }
      })
      .filter((repo) => repo.chats.length > 0)
  }, [groups, query, keptUnread, previewLabels])

  useSessionListTrace(painted, selected)

  const visibleCreating = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return creatingJobs
    return creatingJobs.filter((job) =>
      [job.group_name, job.repo_label, job.branch, job.prompt]
        .filter(Boolean)
        .join('\n')
        .toLowerCase()
        .includes(q),
    )
  }, [creatingJobs, query])

  const replaceSession =
    wide &&
    (rows.some((row) => row.id === selected) || isVirtualSessionId(selected))
  const empty =
    painted.every((repo) => repo.chats.length === 0) &&
    visibleCreating.length === 0
  const searching = query.trim().length > 0

  const title = (
    <h1 className="hidden text-body font-semibold md:block">
      {t({ message: 'Sessions', context: 'nav' })}
    </h1>
  )
  const body = (
    <>
      {sessions.isError ? (
        <p
          role="status"
          className="border-b border-l-[3px] border-b-brand-edge border-l-brand-waiting bg-brand-waiting/10 px-3 py-2.5 text-caption break-words"
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
          <div className="px-4 py-12 text-center">
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
          <p className="px-4 py-12 text-center text-caption text-brand-muted">
            {t`No agent sessions are running.`}
          </p>
        )
      ) : (
        <div
          aria-label={t`Agent sessions`}
          className="grid grid-cols-[minmax(0,1fr)] bg-brand-surface"
          data-testid="session-chats"
        >
          <CreatingSessionsList
            jobs={visibleCreating}
            selected={selected}
            replace={replaceSession}
            timeOf={timeOf}
          />
          {painted.map((repo) => (
            <section
              key={repo.key}
              className="group/repo-section bg-brand-surface"
              data-repo={repo.label}
            >
              <RepoSectionHeader
                label={repo.label}
                repoRoot={repo.repoRoot}
                fallbackCwd={repo.chats[0]?.focus.cwd}
                onOpen={(target) => {
                  setLinksTarget(target)
                  setLinksOpen(true)
                }}
              />
              <ul className="chat-list">
                {repo.chats.map((chat) => (
                  <li
                    key={chat.key}
                    data-worktree={chat.title}
                    data-group={chat.sessions.length > 1 ? '' : undefined}
                  >
                    {chat.sessions.length > 1 ? (
                      <ChatGroupRow
                        chat={chat}
                        selectedId={selected}
                        replace={replaceSession}
                        preview={previewOf(chat)}
                        timeOf={timeOf}
                      />
                    ) : (
                      <ChatRow
                        chat={chat}
                        selectedId={selected}
                        replace={replaceSession}
                        preview={previewOf(chat)}
                        timeLabel={timeOf(chat.focus.ts)}
                      />
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      <RepoLinksSheet
        open={linksOpen}
        onOpenChange={setLinksOpen}
        target={linksTarget}
      />
    </>
  )
  if (split)
    return (
      <SplitColumn
        label={t`Agent sessions`}
        className="bg-brand-surface [--split-pad:0.75rem]"
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
    <div className="flex min-h-full w-full flex-1 flex-col bg-brand-surface">
      <h1 className="sr-only">{t({ message: 'Sessions', context: 'nav' })}</h1>
      <StickyBar className="top-0 mx-0 my-0 border-b border-brand-edge bg-brand-surface/95 px-3 pt-[max(env(safe-area-inset-top),0.5rem)] pb-2">
        <div className="flex min-w-0 items-center gap-2">
          <ChatSearch value={query} onChange={setQuery} />
          <NewSessionButton />
        </div>
      </StickyBar>
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
