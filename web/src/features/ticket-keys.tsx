// Phone ticket list (工单 / 待处理): one key per ticket, each a real link
// (open in a new tab, copy the address); quiet ones fold at the end.
import { useLingui } from '@lingui/react/macro'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'

import { Led } from '#/components/deck/led'
import type { LedTone } from '#/components/deck/led'
import { Button } from '#/components/ui/button'
import { useLocale } from '#/lib/locale-context'
import type { CollabTicket } from '#/lib/runtime-contract'
import { cn } from '#/lib/utils'
import { ticketTone } from './console-collab'
import { RepoRoute, useAgo, useStatusLabel } from './tickets-view'

const toneText: Record<LedTone, string> = {
  running: 'text-brand-running',
  waiting: 'text-brand-waiting',
  done: 'text-brand-done',
  error: 'text-brand-error',
  muted: 'text-brand-label',
}

/** Phone list: one key per ticket, each a real link (open in a new tab, copy). */
export function TicketKeys({
  tickets,
  older,
  empty,
  base,
  selected,
}: {
  tickets: Array<CollabTicket>
  /** wide split: the open ticket, marked; rows replace instead of push */
  selected?: string
  /** quiet ones (splitQuiet), folded at the end */
  older: Array<CollabTicket>
  empty: string
  base: 'collab' | 'inbox'
}) {
  const { t } = useLingui()
  const [showOlder, setShowOlder] = useState(false)
  if (tickets.length === 0 && older.length === 0) {
    return (
      <p className="rounded-2xl bg-brand-surface px-4 py-10 text-center text-caption text-brand-muted">
        {empty}
      </p>
    )
  }
  // folded only under something recent; all quiet → a plain list, no header
  if (tickets.length === 0) {
    tickets = older
    older = []
  }
  const count = older.length
  return (
    <div className="grid gap-3">
      {tickets.length ? (
        <ul
          aria-label={t`Collab tickets`}
          className="overflow-hidden rounded-2xl bg-brand-surface"
        >
          {tickets.map((ticket) => (
            <TicketKey
              key={ticket.id}
              ticket={ticket}
              base={base}
              selected={selected}
            />
          ))}
        </ul>
      ) : null}
      {count ? (
        <section className="overflow-hidden rounded-2xl bg-brand-surface">
          <Button
            variant="plain"
            type="button"
            aria-expanded={showOlder}
            onClick={() => setShowOlder(!showOlder)}
            data-testid="tickets-older"
            className="flex min-h-11 w-full items-center justify-between px-4 text-left text-caption text-brand-muted"
          >
            {t`Quiet for over a week (${count})`}
            <span
              aria-hidden
              className={cn('transition', showOlder && 'rotate-90')}
            >
              ›
            </span>
          </Button>
          {showOlder ? (
            <ul className="border-t border-brand-edge">
              {older.map((ticket) => (
                <TicketKey
                  key={ticket.id}
                  ticket={ticket}
                  base={base}
                  selected={selected}
                />
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}

function TicketKey({
  ticket,
  base,
  selected,
}: {
  ticket: CollabTicket
  base: 'collab' | 'inbox'
  selected?: string
}) {
  const active = selected === ticket.id
  const { locale } = useLocale()
  const ago = useAgo()
  const statusLabel = useStatusLabel()
  const tone = ticketTone(ticket)
  return (
    <li className="border-b border-brand-edge last:border-b-0">
      <Link
        to={
          base === 'inbox'
            ? '/{-$locale}/console/inbox/$id'
            : '/{-$locale}/console/collab/$id'
        }
        params={{ locale: locale === 'en' ? undefined : locale, id: ticket.id }}
        data-ticket={ticket.id}
        // beside the list there is nothing to go back to: switching replaces
        replace={selected !== undefined}
        aria-current={active ? 'page' : undefined}
        className={cn(
          active && 'bg-brand-deck shadow-[inset_3px_0_0_var(--brand-running)]',
          'key-press grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand-running focus-visible:ring-inset md:py-2.5',
        )}
      >
        <span className="pt-1">
          <Led tone={tone} size={13} />
        </span>
        <span className="line-clamp-2 text-title leading-snug font-semibold text-brand-text md:text-body">
          {ticket.title || ticket.id}
        </span>
        <span className="pt-0.5 text-meta text-brand-label">
          {ago(ticket.updated_at)}
        </span>
        <span className="col-start-2 col-end-4 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className={cn('text-meta font-medium', toneText[tone])}>
            {statusLabel(ticket)}
          </span>
          <RepoRoute from={ticket.from} to={ticket.to} />
        </span>
      </Link>
    </li>
  )
}
