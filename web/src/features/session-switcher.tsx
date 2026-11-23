// wezdeck's session keys on the phone. Alt+j / Alt+k / Alt+l jump to the next
// session waiting on you / finished / running (Alt+Shift+l: previous
// running) — on the phone a "N more need you ›" chip in the header and the
// switcher sheet; on a keyboard the same Alt keys. Alt+g / Alt+x pick a
// session — on the phone tap the title: a sheet grouped like the list
// (repo → worktree, by visit). Switching replaces the history entry, so
// back still returns to the list.
import { useLingui } from '@lingui/react/macro'
import { useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect } from 'react'

import { Led } from '#/components/deck/led'
import { useLocale } from '#/lib/locale-context'
import { phoneVisits, recordVisit } from '#/lib/session-visits'
import { cn } from '#/lib/utils'
import { isBusy, needsYou, sessionTone, useSessions } from './console-sessions'
import type { SessionCard } from './console-sessions'
import {
  repoName,
  buildSessionTree,
  nextInCycle,
  visitOf,
  worktreeKey,
} from './session-order'
import { Button } from '#/components/ui/button'
import { Sheet } from '#/components/ui/sheet'

export type JumpKind = 'waiting' | 'done' | 'running'

const KINDS: Record<JumpKind, (row: SessionCard) => boolean> = {
  waiting: (row) => needsYou(row),
  done: (row) => !needsYou(row) && row.status === 'done',
  running: (row) => !needsYou(row) && isBusy(row),
}

const titleOf = (row: SessionCard) =>
  row.title ||
  row.window ||
  (row.worktree || row.cwd).split('/').filter(Boolean).at(-1) ||
  row.id.slice(0, 8)

export function useSessionNav(current: string) {
  const sessions = useSessions()
  const navigate = useNavigate()
  const { locale } = useLocale()
  const rows = sessions.data?.sessions ?? []
  const phone = phoneVisits()
  // the list's own order: waiting band (by visit), then the tree
  const waiting = rows
    .filter(needsYou)
    .sort((a, b) => visitOf(b, phone) - visitOf(a, phone))
  const tree = buildSessionTree(
    rows.filter((row) => !needsYou(row)),
    phone,
  )
  const ordered = [
    ...waiting,
    ...tree.flatMap((repo) => repo.worktrees.flatMap((wt) => wt.rows)),
  ]
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
  return { rows, waiting, tree, ordered, otherWaiting, jump, go }
}

/** Alt+j / Alt+k / Alt+l / Alt+Shift+l, and Alt+g or Alt+x for the sheet */
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
              : key === 'g' || key === 'x'
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
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-brand-waiting/15 px-2 py-0.5 text-[12.5px] text-brand-text"
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
  // stays mounted while closed: the sheet plays its exit before it unmounts
  if (typeof document === 'undefined') return null
  const row = (session: SessionCard, repo?: string) => (
    <li key={session.id}>
      <Button
        variant="plain"
        type="button"
        aria-current={session.id === current ? 'page' : undefined}
        onClick={() => {
          onClose()
          if (session.id !== current) nav.go(session)
        }}
        className={cn(
          'flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left',
          session.id === current && 'bg-brand-soft',
        )}
      >
        <Led
          tone={sessionTone(session.status, session.waiting_kind)}
          size={10}
        />
        <span className="grid min-w-0 flex-1">
          <span className="truncate text-[15px] font-medium">
            {titleOf(session)}
          </span>
          <span className="flex min-w-0 gap-1.5 text-[12px] text-brand-label">
            {session.agent !== 'agent' || session.name ? (
              <span className="shrink-0">
                {session.name && session.name !== session.agent
                  ? `${session.agent} ${session.name}`
                  : session.agent}
              </span>
            ) : null}
            {repo ? <span className="truncate">{repo}</span> : null}
          </span>
        </span>
      </Button>
    </li>
  )
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      title={t`Switch session`}
      testId="session-switcher"
    >
      <div className="grid gap-3 px-3">
        {nav.waiting.length ? (
          <section className="overflow-hidden rounded-[14px] border border-brand-waiting/40 bg-brand-surface">
            <h3 className="px-4 pt-2 text-[12.5px] font-semibold text-brand-muted">
              {t`Needs you`}
            </h3>
            <ul>
              {nav.waiting.map((session) => row(session, repoName(session)))}
            </ul>
          </section>
        ) : null}
        {nav.tree.map((repo) => (
          <section
            key={repo.key}
            className="overflow-hidden rounded-[14px] bg-brand-surface"
          >
            <h3 className="px-4 pt-2 text-[12.5px] font-semibold text-brand-muted">
              {repo.label}
            </h3>
            <ul>
              {repo.worktrees.flatMap((wt) =>
                wt.rows.map((session) =>
                  row(
                    session,
                    repo.worktrees.length > 1 || wt.label !== repo.label
                      ? wt.label
                      : undefined,
                  ),
                ),
              )}
            </ul>
          </section>
        ))}
        <p className="px-1 text-[11.5px] text-brand-label">
          {t`On a keyboard: Alt+j next waiting, Alt+k next finished, Alt+l next running, Alt+g this list.`}
        </p>
      </div>
    </Sheet>
  )
}
