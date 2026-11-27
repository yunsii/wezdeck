// Unified Telegram-style flat ticket rail (工单 / 待处理): edge-to-edge rows on
// bg-brand-surface with inset hairlines, foldable parent-child groups with a
// left vertical rail and bubbled status, swipe-right & context-menu copy
// reference, hover/focus prefetch, and a flat folded strip for quiet tickets.
import { ContextMenu } from '@base-ui/react/context-menu'
import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ChevronDown, ChevronRight, Hash } from 'lucide-react'
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
import { setTicketGroupExpanded, useTicketExpandedMap } from './ticket-collapse'
import { groupIsExpanded } from './ticket-list-groups'
import type { TicketGroup } from './ticket-list-groups'
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

function effectiveGroupTone(group: TicketGroup): LedTone {
  if (group.summary.waiting > 0 || group.root.status === 'waiting_initiator') {
    return 'waiting'
  }
  if (group.summary.running > 0 || group.root.running.length > 0) {
    return 'running'
  }
  if (group.summary.failed > 0) return 'error'
  return ticketTone(group.root)
}

/** Unified flat ticket list with foldable parent-child groups. */
export function TicketKeys({
  groups,
  older,
  empty,
  base,
  selected,
}: {
  groups: Array<TicketGroup>
  /** wide split: the open ticket, marked; rows replace instead of push */
  selected?: string
  /** quiet groups (splitQuietGroups), folded at the end */
  older: Array<TicketGroup>
  empty: string
  base: 'collab' | 'inbox'
}) {
  const { t } = useLingui()
  const [showOlder, setShowOlder] = useState(false)
  const expandedMap = useTicketExpandedMap()
  useDraftRevision()

  if (groups.length === 0 && older.length === 0) {
    return (
      <p className="px-4 py-12 text-center text-caption text-brand-muted">
        {empty}
      </p>
    )
  }
  if (groups.length === 0) {
    groups = older
    older = []
  }
  const count = older.length
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] bg-brand-surface">
      {groups.length ? (
        <ul aria-label={t`Collab tickets`} className="ticket-list">
          {groups.map((group) => (
            <TicketGroupItem
              key={group.root.id}
              group={group}
              expanded={groupIsExpanded(group, expandedMap, selected)}
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
              {older.map((group) => (
                <TicketGroupItem
                  key={group.root.id}
                  group={group}
                  expanded={groupIsExpanded(group, expandedMap, selected)}
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

function TicketGroupItem({
  group,
  expanded,
  base,
  selected,
}: {
  group: TicketGroup
  expanded: boolean
  base: 'collab' | 'inbox'
  selected?: string
}) {
  const { t } = useLingui()
  const hasChildren = group.children.length > 0
  const waitingCount = group.summary.waiting
  const runningCount = group.summary.running
  const groupTone = hasChildren
    ? effectiveGroupTone(group)
    : ticketTone(group.root)

  return (
    <li data-ticket-group={group.root.id}>
      <TicketRow
        ticket={group.root}
        toneOverride={groupTone}
        base={base}
        selected={selected}
        groupMeta={
          hasChildren ? (
            <span className="inline-flex items-center gap-1">
              <Button
                variant="plain"
                size="none"
                type="button"
                aria-expanded={expanded}
                aria-label={
                  expanded ? t`Collapse child tickets` : t`Expand child tickets`
                }
                data-testid="ticket-group-toggle"
                data-parent={group.root.id}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  setTicketGroupExpanded(group.root.id, !expanded)
                }}
                className="inline-flex min-h-6 items-center gap-0.5 rounded-md bg-brand-soft px-1.5 py-0.5 font-mono text-meta text-brand-muted tabular-nums hover:bg-brand-deck hover:text-brand-text"
              >
                {expanded ? (
                  <ChevronDown size={12} aria-hidden />
                ) : (
                  <ChevronRight size={12} aria-hidden />
                )}
                <span>
                  {group.summary.done}/{group.summary.total}
                </span>
              </Button>
              {waitingCount > 0 ? (
                <span
                  data-testid="ticket-group-waiting"
                  className="inline-flex items-center rounded-full bg-brand-waiting/20 px-1.5 py-0.5 text-meta font-semibold text-brand-waiting tabular-nums"
                >
                  {t`${waitingCount} waiting`}
                </span>
              ) : null}
              {runningCount > 0 ? (
                <span className="inline-flex items-center rounded-full bg-brand-running/15 px-1.5 py-0.5 text-meta font-medium text-brand-running tabular-nums">
                  {t`${runningCount} running`}
                </span>
              ) : null}
            </span>
          ) : undefined
        }
      />
      {hasChildren && expanded ? (
        <ul
          data-testid="ticket-group-children"
          aria-label={t`Child tickets`}
          className="relative ml-4 border-l-2 border-brand-edge/70 bg-brand-surface"
        >
          {group.children.map((child) => (
            <li key={child.id}>
              <TicketRow
                ticket={child}
                base={base}
                selected={selected}
                nested
              />
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  )
}

function TicketRow({
  ticket,
  toneOverride,
  base,
  selected,
  nested = false,
  groupMeta,
}: {
  ticket: CollabTicket
  toneOverride?: LedTone
  base: 'collab' | 'inbox'
  selected?: string
  nested?: boolean
  groupMeta?: React.ReactNode
}) {
  const { t } = useLingui()
  const active = selected === ticket.id
  const { locale } = useLocale()
  const client = useQueryClient()
  const ago = useAgo()
  const statusLabel = useStatusLabel()
  const tone = toneOverride ?? ticketTone(ticket)
  const copyReference = useCopyTicketReference()
  const hasDraft = Boolean(
    visibleDraft(ticket.id, selected, readDraft(ticketDraftKey(ticket.id))),
  )
  const warm = () => prefetchTicket(client, ticket.id)
  const copy = () => copyReference(ticket.id)

  return (
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
            data-nested={nested ? 'true' : undefined}
            replace={selected !== undefined}
            aria-current={active ? 'page' : undefined}
            onPointerEnter={warm}
            onPointerDown={warm}
            onFocus={warm}
            className={cn(
              active && 'row-selected',
              'list-row grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2.5 gap-y-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand-running focus-visible:ring-inset',
              nested ? 'py-2 pr-3 pl-3' : 'px-3 py-2.5',
            )}
          >
            <span className="pt-1">
              <Led tone={tone} size={nested ? 9 : 12} />
            </span>
            <span
              className={cn(
                'line-clamp-2 leading-snug font-medium text-brand-text',
                nested ? 'text-caption' : 'text-body',
              )}
            >
              {ticket.title || ticket.id}
            </span>
            <span className="pt-0.5 text-meta text-brand-label tabular-nums">
              {ago(ticket.updated_at)}
            </span>
            <span className="col-start-2 col-end-4 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              {hasDraft ? (
                <span
                  data-testid="ticket-draft"
                  className="inline-flex shrink-0 items-center rounded bg-brand-waiting/15 px-1.5 py-0.5 text-meta leading-none font-semibold text-brand-waiting"
                >
                  {t`Draft`}
                </span>
              ) : null}
              <span className={cn('text-meta font-medium', toneText[tone])}>
                {statusLabel(ticket)}
              </span>
              {groupMeta}
              <RepoRoute
                from={nested ? null : ticket.from}
                to={ticket.to}
                repos={ticket.repos}
                handler={nested ? null : ticket.handler?.repo}
              />
            </span>
          </Link>
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
  )
}
