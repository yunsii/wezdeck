// A worktree running several agent sessions: a foldable header plus one
// stable sub-row per session — own avatar, status tone, preview, unread and
// direct link, so two busy agents no longer repaint one shared focus row in
// turn, and every session stays reachable (list, j / k via data-session).
// Collapsed, the header shows the focus preview (the old single-row look);
// the choice is remembered per worktree (session-collapse.ts).
import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ChevronDown, ChevronRight, Plus } from 'lucide-react'
import type { SyntheticEvent } from 'react'

import { Button } from '#/components/ui/button'
import { useLocale } from '#/lib/locale-context'
import { recordVisit } from '#/lib/session-visits'
import { cn } from '#/lib/utils'
import { AgentAvatar } from './agent-avatar'
import { needsAttention, prefetchSession } from './console-sessions'
import type { SessionCard } from './console-sessions'
import { RowCopyButton, useCopySessionReference } from './copy-reference'
import { clearable, SwipeToClear } from './session-clear'
import type { SessionChat } from './session-chats'
import { chatTone } from './session-chats'
import { useChatCollapsed } from './session-collapse'
import { directionForWorktree, useDirections } from './session-new-direction'
import { requestNewSession } from './session-new'

/** + button on a worktree row: one more parallel slot of the direction */
export function ChatNewRoundButton({ chat }: { chat: SessionChat }) {
  const { t } = useLingui()
  const directions = useDirections(chat.repoKey)
  if (!chat.editable) return null
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
  )
}

const previewToneClass = (tone: ReturnType<typeof chatTone>) =>
  cn(
    'truncate text-caption',
    tone === 'waiting' && 'text-brand-waiting',
    tone === 'done' && 'text-brand-done',
    tone === 'running' && 'text-brand-running',
    tone === 'idle' && 'text-brand-muted',
  )

function UnreadBadge({ tone, n }: { tone: string; n: number }) {
  return (
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
      {n}
    </span>
  )
}

function SessionSubRow({
  chat,
  session,
  selected,
  replace,
  preview,
  timeLabel,
}: {
  chat: SessionChat
  session: SessionCard
  selected: boolean
  replace: boolean
  preview: string
  timeLabel: string
}) {
  const { t } = useLingui()
  const { locale } = useLocale()
  const copyReference = useCopySessionReference()
  const client = useQueryClient()
  const tone = chatTone(session)
  const warm = () => prefetchSession(client, session.id)
  return (
    <SwipeToClear
      id={session.id}
      enabled={clearable(session.status, session.waiting_kind)}
    >
      <div className="group/row relative">
        <Link
          to="/{-$locale}/console/sessions/$id"
          params={{
            locale: locale === 'en' ? undefined : locale,
            id: session.id,
          }}
          data-session={session.id}
          data-chat={chat.key}
          replace={replace}
          aria-current={selected ? 'page' : undefined}
          onClick={() => recordVisit(chat.key)}
          onPointerEnter={warm}
          onPointerDown={warm}
          onFocus={warm}
          className={cn(
            'list-row flex min-h-14 items-start gap-3 py-2 pr-14 pl-8 md:pr-[calc(var(--split-pad)+2.5rem)] md:pl-[calc(var(--split-pad)+1.5rem)]',
            selected && 'row-selected',
          )}
        >
          <AgentAvatar
            agent={session.agent}
            profile={session.agent_profile}
            size={32}
            tone={tone}
            className="mt-0.5"
          />
          <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] gap-0.5">
            <span className="flex items-baseline justify-between gap-2">
              <span
                className={cn(
                  'truncate text-title',
                  session.title ? 'font-medium' : 'text-brand-muted',
                )}
              >
                {session.title || t`Untitled session`}
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                {needsAttention(session) ? (
                  <UnreadBadge tone={tone} n={1} />
                ) : null}
                <span className="text-meta text-brand-label">{timeLabel}</span>
              </span>
            </span>
            <span
              data-testid="session-preview"
              data-tone={tone}
              className={previewToneClass(tone)}
            >
              {preview}
            </span>
          </span>
        </Link>
        <RowCopyButton id={session.id} copy={copyReference} />
      </div>
    </SwipeToClear>
  )
}

export function ChatGroupRow({
  chat,
  selectedId,
  replace,
  previewOf,
  timeOf,
}: {
  chat: SessionChat
  selectedId?: string
  replace: boolean
  previewOf: (row: SessionCard) => string
  timeOf: (ms?: number) => string
}) {
  const { t } = useLingui()
  const [collapsed, toggle] = useChatCollapsed(chat.key)
  const tone = chatTone(chat.focus)
  return (
    <div>
      <div className="group/row relative">
        <Button
          variant="plain"
          size="none"
          type="button"
          data-testid="chat-group-toggle"
          data-chat={chat.key}
          aria-expanded={!collapsed}
          title={collapsed ? t`Expand sessions` : t`Collapse sessions`}
          aria-label={collapsed ? t`Expand sessions` : t`Collapse sessions`}
          onClick={toggle}
          className="flex min-h-12 w-full items-center gap-2 px-4 py-2.5 pr-14 text-left md:px-[var(--split-pad)] md:pr-[calc(var(--split-pad)+2.5rem)]"
        >
          {collapsed ? (
            <ChevronRight
              size={16}
              className="shrink-0 text-brand-label"
              aria-hidden
            />
          ) : (
            <ChevronDown
              size={16}
              className="shrink-0 text-brand-label"
              aria-hidden
            />
          )}
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
                  <UnreadBadge tone={tone} n={chat.unread} />
                ) : null}
                <span className="text-meta text-brand-label">
                  {timeOf(chat.focus.ts)}
                </span>
              </span>
            </span>
            {collapsed ? (
              <span
                data-testid="chat-preview"
                data-tone={tone}
                className={previewToneClass(tone)}
              >
                {previewOf(chat.focus)}
              </span>
            ) : null}
          </span>
        </Button>
        <ChatNewRoundButton chat={chat} />
      </div>
      {collapsed ? null : (
        <ul>
          {chat.sessions.map((session) => (
            <li key={session.id}>
              <SessionSubRow
                chat={chat}
                session={session}
                selected={selectedId === session.id}
                replace={replace}
                preview={previewOf(session)}
                timeLabel={timeOf(session.ts)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
