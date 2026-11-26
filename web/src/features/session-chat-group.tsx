// A worktree running several agent sessions: a foldable header plus one
// stable sub-row per session — own avatar, status tone, preview, unread and
// direct link, so two busy agents no longer repaint one shared focus row in
// turn, and every session stays reachable (list, j / k via data-session).
// Sub-rows share the single-session row's interactions (SwipeActions +
// ContextMenu: copy reference / new round / mark read). The collapsed
// header summarizes unread sessions (session-collapse.ts).
import { ContextMenu } from '@base-ui/react/context-menu'
import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { CheckCheck, ChevronDown, ChevronRight, Hash, Plus } from 'lucide-react'

import { Button } from '#/components/ui/button'
import { useLocale } from '#/lib/locale-context'
import { recordVisit } from '#/lib/session-visits'
import { cn } from '#/lib/utils'
import { AgentAvatar, agentLabel } from './agent-avatar'
import {
  humanPrompt,
  needsAttention,
  prefetchSession,
} from './console-sessions'
import type { SessionCard } from './console-sessions'
import { useCopySessionReference } from './copy-reference'
import { useDeleteSession } from './session-delete'
import { useDeviceState } from './device-state'
import { clearable, useClearSession } from './session-clear'
import type { ChatTone, SessionChat } from './session-chats'
import { chatTone } from './session-chats'
import { useChatCollapsed } from './session-collapse'
import { requestNewSession } from './session-new'
import { hasEditableGroupName } from './session-order'
import { WorktreePurpose } from './session-purpose'
import { SwipeActions } from './session-row-swipe'

const menuItemClass =
  'flex cursor-default items-center gap-2 rounded-lg px-3 py-2 outline-none data-[highlighted]:bg-brand-soft'

const statusToneClass = (tone: ChatTone) =>
  cn(
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
  timeLabel,
}: {
  chat: SessionChat
  session: SessionCard
  selected: boolean
  replace: boolean
  timeLabel: string
}) {
  const { t } = useLingui()
  const { locale } = useLocale()
  const device = useDeviceState()
  const copyReference = useCopySessionReference()
  const { clear } = useClearSession()
  const client = useQueryClient()
  const tone = chatTone(session)
  const title = session.title?.trim()
  const prompt = humanPrompt(session.last_prompt).trim()
  const draft = session.draft?.trim()
  const compact =
    tone === 'idle' && !title && !prompt && !draft && !session.restart_pending
  const statusLabel = session.restart_pending
    ? t`Restarting…`
    : {
        idle: '',
        running: t`Working`,
        waiting: t`Waiting on you`,
        done: t`Done`,
      }[tone]
  const warm = () => prefetchSession(client, session.id)
  const canClear =
    device.state === 'approved' &&
    clearable(session.status, session.waiting_kind)
  const deleteSession = useDeleteSession()
  const canManage = device.state === 'approved' && Boolean(session.tmux_pane)
  const copy = () => copyReference(session.id)
  return (
    <SwipeActions
      id={session.id}
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
              onAction: () => clear(session.id),
            }
          : undefined
      }
    >
      <ContextMenu.Root>
        <ContextMenu.Trigger
          data-testid="session-row-menu"
          className={cn(
            'group/row relative block w-full select-none outline-none [-webkit-touch-callout:none]',
            'data-[popup-open]:bg-brand-soft',
          )}
        >
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
              'list-row flex items-center gap-3 px-4 py-2 md:px-[var(--split-pad)]',
              compact ? 'min-h-11' : 'min-h-14',
              selected && 'row-selected',
            )}
          >
            <AgentAvatar
              agent={session.agent}
              profile={session.agent_profile}
              size={26}
              tone={tone}
            />
            <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] gap-0.5">
              <span className="flex items-baseline justify-between gap-2">
                <span
                  className={cn(
                    'min-w-0 truncate text-body',
                    compact ? 'text-brand-muted' : 'font-medium',
                  )}
                >
                  {compact
                    ? `${agentLabel(session.agent, session.agent_profile)} · ${t`New session`}`
                    : title || agentLabel(session.agent, session.agent_profile)}
                </span>
                {compact ? null : (
                  <span className="flex shrink-0 items-center gap-1.5">
                    {needsAttention(session) ? (
                      <UnreadBadge tone={tone} n={1} />
                    ) : null}
                    <span className="text-meta text-brand-label">
                      {timeLabel}
                    </span>
                  </span>
                )}
              </span>
              {draft || prompt || statusLabel ? (
                <span
                  data-testid="session-preview"
                  data-tone={tone}
                  className="flex min-w-0 items-baseline gap-1.5 text-caption text-brand-muted"
                >
                  {statusLabel ? (
                    <span className={cn('shrink-0', statusToneClass(tone))}>
                      {statusLabel}
                    </span>
                  ) : null}
                  {draft ? (
                    <span className="truncate text-brand-label">
                      {t`Draft`} · {draft}
                    </span>
                  ) : prompt ? (
                    <span className="truncate">{prompt}</span>
                  ) : null}
                </span>
              ) : null}
            </span>
          </Link>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Positioner className="z-[60]">
            <ContextMenu.Popup
              data-deck
              data-testid="session-row-context-menu"
              className="motion-pop min-w-44 rounded-xl border border-brand-edge bg-brand-surface p-1 text-body text-brand-text shadow-lg outline-none"
            >
              <ContextMenu.Item
                data-testid="session-row-copy-reference"
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
                        anchor: session.id,
                        group: chat.purpose || chat.title,
                      })
                    }
                  >
                    <Plus size={14} aria-hidden />
                    {t`New session in this group`}
                  </ContextMenu.Item>
                  <ContextMenu.Item
                    className={menuItemClass}
                    onClick={() => void deleteSession(session, selected)}
                  >
                    {t`Delete session`}
                  </ContextMenu.Item>
                </>
              ) : null}
              {canClear ? (
                <ContextMenu.Item
                  data-testid="session-row-mark-read"
                  onClick={() => void clear(session.id)}
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

export function ChatGroupRow({
  chat,
  selectedId,
  replace,
  timeOf,
}: {
  chat: SessionChat
  selectedId?: string
  replace: boolean
  timeOf: (ms?: number) => string
}) {
  const { t } = useLingui()
  const device = useDeviceState()
  const anchor = chat.sessions.find((session) => session.tmux_pane)
  const [collapsed, toggle] = useChatCollapsed(chat.key)
  const tone = chat.sessions.some((session) => chatTone(session) === 'waiting')
    ? 'waiting'
    : 'done'
  const hasDraft = chat.sessions.some((session) =>
    Boolean(session.draft?.trim()),
  )
  return (
    <div>
      <div className="flex items-center">
        <Button
          variant="plain"
          size="none"
          type="button"
          data-testid="chat-group-toggle"
          data-chat={chat.key}
          aria-expanded={!collapsed}
          title={collapsed ? t`Expand sessions` : t`Collapse sessions`}
          aria-label={chat.purpose || chat.title}
          onClick={toggle}
          className="flex min-h-10 min-w-0 flex-1 items-center gap-1.5 px-4 py-1 text-left text-caption text-brand-label md:px-[var(--split-pad)]"
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
          <span className="min-w-0 flex-1 truncate font-medium">
            {chat.purpose || chat.title}
          </span>
          {collapsed && hasDraft ? (
            <span className="shrink-0 text-meta text-brand-label">{t`Draft`}</span>
          ) : null}
          {collapsed && chat.unread > 0 ? (
            <UnreadBadge tone={tone} n={chat.unread} />
          ) : null}
        </Button>
        <WorktreePurpose
          compact
          worktree={chat.key}
          description={chat.purpose}
          editable={hasEditableGroupName(chat.focus)}
        />
        {anchor && device.state === 'approved' ? (
          <Button
            variant="plain"
            type="button"
            aria-label={t`New session in this group`}
            title={t`New session in this group`}
            onClick={() =>
              requestNewSession({
                repo: chat.repoKey,
                anchor: anchor.id,
                group: chat.purpose || chat.title,
              })
            }
            className="mr-2 size-10 shrink-0 text-brand-muted"
          >
            <Plus size={16} aria-hidden />
          </Button>
        ) : null}
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
                timeLabel={timeOf(session.ts)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
