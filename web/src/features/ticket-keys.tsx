// Unified Telegram-style flat ticket rail (工单 / 待处理): edge-to-edge rows on
// bg-brand-surface with inset hairlines, swipe-right & context-menu copy
// reference, hover/focus prefetch, and a flat folded strip for quiet tickets.
import { ContextMenu } from '@base-ui/react/context-menu'
import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Hash } from 'lucide-react'
import { useState } from 'react'

import { Led } from '#/components/deck/led'
import type { LedTone } from '#/components/deck/led'
import { Button } from '#/components/ui/button'
import { useLocale } from '#/lib/locale-context'
import type { CollabTicket } from '#/lib/runtime-contract'
import {
  readDraft,
  ticketDraftKey,
  useDraftRevision,
  visibleDraft,
} from '#/lib/use-draft'
import { cn } from '#/lib/utils'
import { ticketTone } from './console-collab'
import { RowCopyButton, useCopyTicketReference } from './copy-reference'
import { SwipeActions } from './session-row-swipe'
import { prefetchTicket } from './ticket-autosync'
import { RepoRoute, useAgo, useStatusLabel } from './tickets-view'

const toneText: Record<LedTone, string> = {
  running: 'text-brand-running',
  waiting: 'text-brand-waiting',
  done: 'text-brand-done',
  error: 'text-brand-error',
  muted: 'text-brand-label',
}

const menuItemClass =
  'flex cursor-default items-center gap-2 rounded-lg px-3 py-2 outline-none data-[highlighted]:bg-brand-soft'

/** Unified flat ticket list: each row is a real link with swipe + context menu. */
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
  useDraftRevision()
  if (tickets.length === 0 && older.length === 0) {
    return (
      <p className="px-4 py-12 text-center text-caption text-brand-muted">
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
    <div className="grid grid-cols-[minmax(0,1fr)] bg-brand-surface">
      {tickets.length ? (
        <ul aria-label={t`Collab tickets`} className="ticket-list">
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
        <section className="bg-brand-surface">
          <Button
            variant="plain"
            type="button"
            aria-expanded={showOlder}
            onClick={() => setShowOlder(!showOlder)}
            data-testid="tickets-older"
            className="flex min-h-9 w-full items-center justify-between border-y border-brand-edge bg-brand-deck px-3 py-1.5 text-left text-meta font-semibold text-brand-label transition-colors hover:text-brand-text"
          >
            {t`Quiet for over a week (${count})`}
            <span
              aria-hidden
              className={cn('transition-transform', showOlder && 'rotate-90')}
            >
              ›
            </span>
          </Button>
          {showOlder ? (
            <ul className="ticket-list bg-brand-surface">
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
  const { t } = useLingui()
  const active = selected === ticket.id
  const { locale } = useLocale()
  const client = useQueryClient()
  const ago = useAgo()
  const statusLabel = useStatusLabel()
  const tone = ticketTone(ticket)
  const copyReference = useCopyTicketReference()
  const hasDraft = Boolean(
    visibleDraft(ticket.id, selected, readDraft(ticketDraftKey(ticket.id))),
  )
  const warm = () => prefetchTicket(client, ticket.id)
  const copy = () => copyReference(ticket.id)
  return (
    <li>
      <SwipeActions
        id={ticket.id}
        left={{
          label: t`Copy reference`,
          className: 'bg-brand-soft text-brand-text',
          testId: 'ticket-swipe-copy',
          onAction: copy,
        }}
      >
        <ContextMenu.Root>
          <ContextMenu.Trigger
            data-testid="ticket-row-menu"
            className={cn(
              'group/row relative block w-full select-none outline-none [-webkit-touch-callout:none]',
              'data-[popup-open]:bg-brand-soft',
            )}
          >
            <Link
              to={
                base === 'inbox'
                  ? '/{-$locale}/console/inbox/$id'
                  : '/{-$locale}/console/collab/$id'
              }
              params={{
                locale: locale === 'en' ? undefined : locale,
                id: ticket.id,
              }}
              data-ticket={ticket.id}
              // beside the list there is nothing to go back to: switching replaces
              replace={selected !== undefined}
              aria-current={active ? 'page' : undefined}
              onPointerEnter={warm}
              onPointerDown={warm}
              onFocus={warm}
              className={cn(
                active && 'row-selected',
                'list-row grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand-running focus-visible:ring-inset',
              )}
            >
              <span className="pt-1">
                <Led tone={tone} size={12} />
              </span>
              <span className="line-clamp-2 text-body leading-snug font-medium text-brand-text">
                {ticket.title || ticket.id}
              </span>
              <span className="pt-0.5 text-meta text-brand-label tabular-nums">
                {ago(ticket.updated_at)}
              </span>
              <span className="col-start-2 col-end-4 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                {hasDraft ? (
                  <span
                    data-testid="ticket-draft"
                    className="shrink-0 rounded bg-brand-waiting/15 px-1.5 py-0.5 text-meta font-semibold text-brand-waiting"
                  >
                    {t`Draft`}
                  </span>
                ) : null}
                <span className={cn('text-meta font-medium', toneText[tone])}>
                  {statusLabel(ticket)}
                </span>
                <RepoRoute from={ticket.from} to={ticket.to} />
              </span>
            </Link>
            {/* desktop hover shortcut; phones use swipe-right or long-press menu */}
            <RowCopyButton
              id={ticket.id}
              copy={copyReference}
              className="hidden md:left-1.5 md:grid"
            />
          </ContextMenu.Trigger>
          <ContextMenu.Portal>
            <ContextMenu.Positioner className="z-50 outline-none">
              <ContextMenu.Popup className="min-w-44 rounded-xl border border-brand-edge bg-brand-surface p-1 text-body text-brand-text shadow-lg outline-none">
                <ContextMenu.Item
                  className={menuItemClass}
                  onClick={() => void copy()}
                >
                  <Hash size={15} className="text-brand-muted" aria-hidden />
                  {t`Copy reference`}
                </ContextMenu.Item>
              </ContextMenu.Popup>
            </ContextMenu.Positioner>
          </ContextMenu.Portal>
        </ContextMenu.Root>
      </SwipeActions>
    </li>
  )
}
