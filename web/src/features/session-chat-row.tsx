// Single-session workstation row in the unified Telegram-style flat IM list:
// 40 px brand avatar, title + optional named-workstation hint, clock time on
// line 1, draft + tone-coloured preview + unread count on line 2, with swipe
// actions and desktop/long-press context menu.
import { ContextMenu } from '@base-ui/react/context-menu'
import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { CheckCheck, Hash, Plus } from 'lucide-react'

import { useLocale } from '#/lib/locale-context'
import { recordVisit } from '#/lib/session-visits'
import { visibleDraft } from '#/lib/use-draft'
import { cn } from '#/lib/utils'
import { AgentAvatar, agentLabel } from './agent-avatar'
import { prefetchSession } from './console-sessions'
import { useCopySessionReference } from './copy-reference'
import { useDeviceState } from './device-state'
import type { SessionChat } from './session-chats'
import { chatTone } from './session-chats'
import { clearable, useClearSession } from './session-clear'
import { useDeleteSession } from './session-delete'
import { requestNewSession } from './session-new'
import { SwipeActions } from './session-row-swipe'

const menuItemClass =
  'flex cursor-default items-center gap-2 rounded-lg px-3 py-2 outline-none data-[highlighted]:bg-brand-soft'

export function ChatRow({
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
  const { ask: deleteSession, confirmation } = useDeleteSession()
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
              'list-row flex min-h-16 items-center gap-3 px-3 py-2',
              selected && 'row-selected',
            )}
          >
            <AgentAvatar
              agent={row.agent}
              profile={row.agent_profile}
              size={40}
              tone={tone}
            />
            <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] gap-0.5">
              <span className="flex items-baseline justify-between gap-2">
                <span
                  data-testid="chat-title"
                  className={cn(
                    'min-w-0 truncate text-body',
                    chat.unread > 0 ? 'font-semibold' : 'font-medium',
                  )}
                >
                  {row.title?.trim() ||
                    agentLabel(row.agent, row.agent_profile)}
                </span>
                <span className="shrink-0 text-meta text-brand-label tabular-nums">
                  {timeLabel}
                </span>
              </span>
              <span className="flex min-w-0 items-center justify-between gap-2 text-caption leading-5">
                <span className="flex min-w-0 items-center gap-1.5">
                  {visibleDraft(row.id, selectedId, row.draft ?? '') ? (
                    <span
                      data-testid="chat-draft"
                      className="inline-flex shrink-0 items-center rounded bg-brand-waiting/15 px-1.5 py-0.5 text-meta leading-none font-semibold text-brand-waiting"
                    >
                      {t`Draft`}
                    </span>
                  ) : null}
                  <span
                    data-testid="chat-preview"
                    data-tone={tone}
                    className={cn(
                      'min-w-0 truncate',
                      tone === 'waiting' && 'text-brand-waiting',
                      tone === 'done' && 'text-brand-done',
                      tone === 'running' && 'text-brand-running',
                      tone === 'idle' && 'text-brand-muted',
                    )}
                  >
                    {preview}
                  </span>
                </span>
                {chat.unread > 0 ? (
                  <span
                    data-testid="chat-unread"
                    data-tone={tone}
                    className={cn(
                      'inline-flex min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-meta font-semibold tabular-nums',
                      tone === 'done'
                        ? 'bg-brand-done text-[#0b1a12]'
                        : 'bg-brand-waiting text-[#1b1406]',
                    )}
                  >
                    {chat.unread}
                  </span>
                ) : null}
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
                    onClick={() => deleteSession(row, selected)}
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
      {confirmation}
    </SwipeActions>
  )
}
