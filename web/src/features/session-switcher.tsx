// wezdeck's session keys on the phone. Alt+j / Alt+k / Alt+l jump to the next
// session waiting on you / finished / running (Alt+Shift+l: previous
// running) — on the phone a "N more need you ›" chip in the header and the
// switcher sheet; on a keyboard the same Alt keys. Alt+g / Alt+x pick a
// chat — sheet grouped like the IM list (repo → workstation). Switching
// replaces the history entry, so back still returns to the list.
import { useLingui } from '@lingui/react/macro'
import { useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect } from 'react'

import { Led } from '#/components/deck/led'
import { useLocale } from '#/lib/locale-context'
import { consoleVisits, recordVisit } from '#/lib/session-visits'
import { cn } from '#/lib/utils'
import { isBusy, needsYou, useSessions } from './console-sessions'
import { AgentAvatar } from './agent-avatar'
import type { SessionCard } from './console-sessions'
import { buildChatGroups, flattenChats } from './session-chats'
import type { SessionChat } from './session-chats'
import { nextInCycle, worktreeKey } from './session-order'
import { Button } from '#/components/ui/button'
import { Sheet } from '#/components/ui/sheet'

export type JumpKind = 'waiting' | 'done' | 'running'

const KINDS: Record<JumpKind, (row: SessionCard) => boolean> = {
  waiting: (row) => needsYou(row),
  done: (row) => !needsYou(row) && row.status === 'done',
  running: (row) => !needsYou(row) && isBusy(row),
}

export function useSessionNav(current: string) {
  const sessions = useSessions()
  const navigate = useNavigate()
  const { locale } = useLocale()
  const rows = sessions.data?.sessions ?? []
  const phone = consoleVisits()
  const groups = buildChatGroups(rows, phone)
  const chats = flattenChats(groups)
  // jump targets: focus session of each matching chat (one id per workstation)
  const ordered = chats.map((c) => c.focus)
  const waiting = chats.filter((c) => c.unread > 0).map((c) => c.focus)
  const ids = (kind: JumpKind) =>
    ordered.filter(KINDS[kind]).map((row) => row.id)
  const go = useCallback(
    (row: SessionCard | string) => {
      const target =
        typeof row === 'string' ? rows.find((r) => r.id === row) : row
      if (!target) return
      recordVisit(worktreeKey(target))
      void navigate({
        to: '/{-$locale}/console/sessions/$id',
        params: { locale: locale === 'en' ? undefined : locale, id: target.id },
        replace: true,
      })
    },
    [rows, navigate, locale],
  )
  const jump = (kind: JumpKind, step = 1) => {
    const id = nextInCycle(ids(kind), current, step)
    if (id) go(id)
  }
  const otherWaiting = waiting.filter((row) => row.id !== current)
  return { rows, waiting, groups, chats, ordered, otherWaiting, jump, go }
}

/**
 * Alt+j / Alt+k / Alt+l / Alt+Shift+l, and Alt+g, Alt+x or Alt+/ (the
 * desk's pending-task overlay) for the sheet
 */
export function useSessionKeys(
  jump: (kind: JumpKind, step?: number) => void,
  openSwitcher: () => void,
) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey) return
      const key = event.code.replace(/^Key/, '').toLowerCase()
      const action =
        key === 'j'
          ? () => jump('waiting')
          : key === 'k'
            ? () => jump('done')
            : key === 'l'
              ? () => jump('running', event.shiftKey ? -1 : 1)
              : key === 'g' || key === 'x' || event.code === 'Slash'
                ? openSwitcher
                : null
      if (!action) return
      event.preventDefault()
      action()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [jump, openSwitcher])
}

export function NextWaitingChip({
  count,
  onNext,
}: {
  count: number
  onNext: () => void
}) {
  const { t } = useLingui()
  if (!count) return null
  return (
    <Button
      variant="plain"
      type="button"
      onClick={onNext}
      data-testid="next-waiting"
      title="Alt+j"
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-brand-waiting/15 px-2 py-0.5 text-caption text-brand-text"
    >
      <Led tone="waiting" size={10} />
      {t`${count} more need you`} ›
    </Button>
  )
}

export function SessionSwitcher({
  current,
  open,
  onClose,
}: {
  current: string
  open: boolean
  onClose: () => void
}) {
  const { t } = useLingui()
  const nav = useSessionNav(current)
  const currentRow = nav.rows.find((r) => r.id === current)
  const currentKey = currentRow ? worktreeKey(currentRow) : ''
  if (typeof document === 'undefined') return null
  const row = (chat: SessionChat) => {
    const session = chat.focus
    const selected = chat.key === currentKey || session.id === current
    return (
      <li key={chat.key}>
        <Button
          variant="plain"
          type="button"
          aria-current={selected ? 'page' : undefined}
          data-session-id={session.id}
          data-chat={chat.key}
          onClick={() => {
            onClose()
            if (session.id !== current) nav.go(session)
          }}
          className={cn(
            'flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left',
            selected && 'bg-brand-soft',
          )}
        >
          <AgentAvatar
            agent={session.agent}
            profile={session.agent_profile}
            size={36}
          />
          <span className="grid min-w-0 flex-1">
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span className="truncate text-body font-medium">
                {chat.title}
              </span>
              {chat.purpose ? (
                <span className="min-w-0 truncate text-meta text-brand-label">
                  · {chat.purpose}
                </span>
              ) : null}
              {chat.unread > 0 ? (
                <span className="ml-auto shrink-0 rounded-full bg-brand-waiting px-1.5 text-meta font-semibold text-[#1b1406]">
                  {chat.unread}
                </span>
              ) : null}
            </span>
            <span className="truncate text-meta text-brand-label">
              {session.title || session.last_prompt || t`No human message yet`}
            </span>
          </span>
        </Button>
      </li>
    )
  }
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      title={t`Switch chat`}
      testId="session-switcher"
    >
      <div className="grid gap-3 px-3">
        {nav.groups.map((repo) => (
          <section
            key={repo.key}
            className="overflow-hidden rounded-xl bg-brand-surface"
          >
            <h3 className="px-4 pt-2 text-caption font-semibold text-brand-muted">
              {repo.label}
            </h3>
            <ul>{repo.chats.map((chat) => row(chat))}</ul>
          </section>
        ))}
        <p className="px-1 text-meta text-brand-label">
          {t`On a keyboard: Alt+j next waiting, Alt+k next finished, Alt+l next running, Alt+g this list.`}
        </p>
      </div>
    </Sheet>
  )
}
