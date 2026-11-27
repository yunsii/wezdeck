// Repo tickets drawer on the Session page (replaces legacy SQLite todos):
// shows open agent-collab tickets targeting the current session's repository,
// lets the user open a ticket, drop its reference + attachments into the chat
// composer, or capture a new AI-structured ticket (defaulting to this repo,
// switchable to any other configured target repo). Shortcut: `t`.
import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  Copy,
  CornerDownLeft,
  ExternalLink,
  ImageIcon,
  Sparkles,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'

import { Led } from '#/components/deck/led'
import { OverlayScroll } from '#/components/deck/overlay-scroll'
import { Button } from '#/components/ui/button'
import { Sheet } from '#/components/ui/sheet'
import { collabKey } from '#/lib/collab-query'
import { trace } from '#/lib/client-trace'
import { useLocale } from '#/lib/locale-context'
import { getCollab } from '#/lib/runtime-client'
import type { CollabTicket } from '#/lib/runtime-contract'
import { useTicketList } from '#/lib/ticket-sync'
import type { MessagePayload } from './composer-images'
import { ticketTone } from './console-collab'
import { useCopyTicketReference } from './copy-reference'
import { QuickTicketForm, useTicketTargets } from './ticket-quick-form'

const TERMINAL_STATUSES = new Set(['closed', 'rejected', 'shipped'])

export function useRepoTickets(session: string, enabled = true) {
  const targets = useTicketTargets(session, enabled)
  const list = useTicketList()
  const targetKey = targets.data?.session_target ?? ''
  const openTickets = useMemo(() => {
    const all: Array<CollabTicket> = list.data?.ok ? list.data.tickets : []
    if (!targetKey) return []
    return all.filter(
      (item) =>
        !TERMINAL_STATUSES.has(item.status ?? '') &&
        (item.to === targetKey || item.repos.includes(targetKey)),
    )
  }, [list.data, targetKey])
  return {
    targetKey,
    openTickets,
    isPending: targets.isPending || list.isPending,
    isError: list.isError,
    error: list.error,
  }
}

function RepoTicketRow({
  ticket,
  busy,
  onOpen,
  onUse,
  onCopy,
}: {
  ticket: CollabTicket
  busy: boolean
  onOpen: () => void
  onUse?: () => void
  onCopy: () => void
}) {
  const { t } = useLingui()
  const attCount = ticket.attachments_count ?? 0
  const enriching = ticket.enrich_status === 'pending'
  return (
    <li
      data-testid="repo-ticket-row"
      className="grid min-w-0 gap-1.5 rounded-xl bg-brand-surface p-3"
    >
      <div className="flex min-w-0 items-start gap-2">
        <span className="mt-1 shrink-0">
          <Led tone={ticketTone(ticket)} size={9} />
        </span>
        <Button
          variant="plain"
          size="none"
          type="button"
          onClick={onOpen}
          className="min-w-0 flex-1 text-left text-body leading-snug font-medium break-words text-brand-text hover:underline"
        >
          {ticket.title || ticket.id}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 pl-4 text-meta text-brand-muted">
        <span className="font-mono text-brand-label">{ticket.id}</span>
        {enriching ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-brand-running/10 px-1.5 py-px text-brand-running">
            <Sparkles size={11} aria-hidden />
            {t`AI structuring`}
          </span>
        ) : null}
        {attCount > 0 ? (
          <span className="inline-flex items-center gap-1 text-brand-label">
            <ImageIcon size={12} aria-hidden />
            {attCount}
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-4 pt-0.5 text-meta">
        {onUse ? (
          <Button
            variant="link"
            size="none"
            type="button"
            disabled={busy}
            onClick={onUse}
            className="inline-flex items-center gap-1 text-brand-text"
          >
            <CornerDownLeft size={13} aria-hidden />
            {t`Put in input`}
          </Button>
        ) : null}
        <Button
          variant="link"
          size="none"
          type="button"
          onClick={onOpen}
          className="inline-flex items-center gap-1 text-brand-running"
        >
          <ExternalLink size={13} aria-hidden />
          {t`Open`}
        </Button>
        <Button
          variant="link"
          size="none"
          type="button"
          onClick={onCopy}
          className="inline-flex items-center gap-1 text-brand-muted"
        >
          <Copy size={13} aria-hidden />
          {t`Copy ref`}
        </Button>
      </div>
    </li>
  )
}

export function RepoTicketsSheet({
  session,
  writable,
  open,
  onOpenChange,
  onUsePayload,
}: {
  session: string
  writable: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onUsePayload?: (payload: MessagePayload) => void
}) {
  const { t } = useLingui()
  const { locale } = useLocale()
  const navigate = useNavigate()
  const client = useQueryClient()
  const copyReference = useCopyTicketReference()
  const { targetKey, openTickets, isPending, isError, error } = useRepoTickets(
    session,
    open,
  )
  const [loadingId, setLoadingId] = useState('')

  const openTicket = (id: string) => {
    onOpenChange(false)
    void navigate({
      to: '/{-$locale}/console/collab/$id',
      params: { locale: locale === 'en' ? undefined : locale, id },
    })
  }

  const useTicketInComposer = async (ticket: CollabTicket) => {
    if (!onUsePayload) return
    setLoadingId(ticket.id)
    try {
      const show = await client.fetchQuery({
        queryKey: collabKey('show', { id: ticket.id }),
        queryFn: () => getCollab('show', { id: ticket.id }),
        staleTime: 10_000,
      })
      const refText =
        show.ok && show.reference
          ? show.reference.trim()
          : `${ticket.id}: ${ticket.title || ticket.id}`
      const attachments = show.ok ? (show.attachments ?? []) : []
      trace('repo-tickets', {
        action: 'put-in-input',
        id: ticket.id,
        attachments: attachments.length,
      })
      onOpenChange(false)
      onUsePayload({ text: refText, attachments })
    } catch {
      onOpenChange(false)
      onUsePayload({
        text: `${ticket.id}: ${ticket.title || ticket.id}`,
        attachments: [],
      })
    } finally {
      setLoadingId('')
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      testId="repo-tickets-sheet"
      title={targetKey ? t`Tickets of ${targetKey}` : t`Repo tickets`}
      write
    >
      <div className="grid min-w-0 gap-3 px-4 pb-2">
        {isError ? (
          <p role="alert" className="text-meta text-brand-error">
            {String(error?.message ?? '')}
          </p>
        ) : null}

        <OverlayScroll
          data-testid="repo-tickets-body"
          className="h-[min(36dvh,17rem)]"
        >
          <ul className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-2 pr-0.5">
            {openTickets.length === 0 && !isPending ? (
              <li className="py-10 text-center text-caption text-brand-muted">
                {targetKey
                  ? t`No open tickets for ${targetKey}.`
                  : t`This repo is not in ticket targets yet — you can still file a ticket to any configured repo below.`}
              </li>
            ) : null}
            {openTickets.map((ticket) => (
              <RepoTicketRow
                key={ticket.id}
                ticket={ticket}
                busy={loadingId === ticket.id}
                onOpen={() => openTicket(ticket.id)}
                onUse={
                  onUsePayload
                    ? () => void useTicketInComposer(ticket)
                    : undefined
                }
                onCopy={() => void copyReference(ticket.id)}
              />
            ))}
          </ul>
        </OverlayScroll>

        {writable ? (
          <div className="border-t border-brand-edge pt-3">
            <QuickTicketForm
              compact
              sessionId={session}
              defaultTo={targetKey}
              draftKey={`session:${session}`}
              onCreated={(info) => {
                const ticketId = info.id
                toast(
                  info.enriching
                    ? t`Ticket ${ticketId} created (AI structuring in background)`
                    : t`Ticket ${ticketId} created`,
                  {
                    action: {
                      label: t`Open`,
                      onClick: () => openTicket(ticketId),
                    },
                  },
                )
              }}
            />
          </div>
        ) : null}
      </div>
    </Sheet>
  )
}
