// Session keyboard navigation: Alt+j / Alt+k / Alt+l / Alt+Shift+l jump to the
// next session waiting on you / finished / running in the list's order, replacing
// the history entry so back returns to the list. Alt+g / Alt+x / Alt+/ focus the
// list search box (or return to the list on narrow screens).
import { useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect } from 'react'

import { useLocale } from '#/lib/locale-context'
import { recordVisit } from '#/lib/session-visits'
import { isBusy, needsYou, useSessions } from './console-sessions'
import type { SessionCard } from './console-sessions'
import { buildChatGroups, flattenChats } from './session-chats'
import { nextInCycle, worktreeKey } from './session-order'

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
  const groups = buildChatGroups(rows)
  const chats = flattenChats(groups)
  // jump targets: every session, not just each worktree's focus — two agents
  // in one worktree each get their own stop (Alt+l cycles both). `ordered`
  // keeps one focus id per worktree for the split's default pick.
  const ordered = chats.map((c) => c.focus)
  const allSessions = chats.flatMap((c) => c.sessions)
  const ids = (kind: JumpKind) =>
    allSessions.filter(KINDS[kind]).map((row) => row.id)
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
  return { rows, groups, chats, ordered, jump, go }
}

/**
 * Alt+j / Alt+k / Alt+l / Alt+Shift+l jump across sessions; Alt+g / Alt+x / Alt+/
 * focus the list search box (or return to the list on narrow screens).
 */
export function useSessionKeys(
  jump: (kind: JumpKind, step?: number) => void,
  onFindList: () => void,
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
                ? onFindList
                : null
      if (!action) return
      event.preventDefault()
      action()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [jump, onFindList])
}
