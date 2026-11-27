// Sticky top bar of a ticket page (mirroring SessionHeader): mobile back
// button, status LED + tappable ticket title (opens TicketInfo sheet),
// fullscreen Net Diff trigger (`d` shortcut), and ⓘ.
import { useLingui } from '@lingui/react/macro'
import { GitCompareArrows, Info } from 'lucide-react'
import { useEffect, useState } from 'react'

import { BackButton } from '#/components/deck/back-button'
import { Led } from '#/components/deck/led'
import { Button } from '#/components/ui/button'
import type { CollabShow } from '#/lib/runtime-contract'
import { ticketTone } from './console-collab'
import { TicketDiffSheet } from './ticket-diff'
import { TicketInfo } from './ticket-info'
import { formatRepoRoute, useStatusLabel } from './tickets-view'

export function TicketHeader({
  data,
  onBack,
}: {
  data: CollabShow
  onBack?: () => void
}) {
  const { t } = useLingui()
  const statusLabel = useStatusLabel()
  const [infoOpen, setInfoOpen] = useState(false)
  const [diffOpen, setDiffOpen] = useState(false)
  const ticket = data.ticket
  const canInspectDiff = Boolean(
    ticket &&
    (ticket.worktree ||
      ticket.branch ||
      data.runs.length > 0 ||
      data.children_detail.length > 0 ||
      data.collab?.integration),
  )

  // Keyboard shortcut: `d` opens the fullscreen net Diff drawer.
  useEffect(() => {
    if (!canInspectDiff) return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        event.key !== 'd' ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.closest('input, textarea, select, [contenteditable="true"]') ||
        document.querySelector('[role="dialog"]')
      ) {
        return
      }
      event.preventDefault()
      setDiffOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canInspectDiff])

  if (!ticket) return null
  const tone = ticketTone(ticket)
  const title = ticket.title || ticket.id
  const route = formatRepoRoute(ticket.from, ticket.to, ticket.repos)
  const handlerRepo = ticket.handler?.repo ?? ''
  const targets =
    ticket.repos.length > 0 ? ticket.repos : ticket.to ? [ticket.to] : []
  const showHandler =
    Boolean(handlerRepo) &&
    handlerRepo !== ticket.from &&
    !targets.includes(handlerRepo)

  return (
    <header
      data-testid="ticket-header"
      className="sticky top-0 z-30 -mx-[var(--page-x)] border-b border-brand-edge bg-brand-deck px-[var(--page-x)] pt-[max(env(safe-area-inset-top),0.375rem)] pb-2 md:pt-2"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {onBack ? (
          <BackButton
            onClick={onBack}
            label={t`Back`}
            className="-ml-2 md:hidden"
          />
        ) : null}
        <div className="flex min-w-0 flex-1 items-center gap-2.5 px-1 py-0.5">
          <Led tone={tone} size={13} />
          <div className="grid min-w-0 flex-1">
            <h1 className="min-w-0 truncate text-body leading-snug font-semibold text-brand-text">
              <Button
                variant="plain"
                size="none"
                type="button"
                aria-haspopup="dialog"
                data-testid="ticket-title"
                data-ticket-id={ticket.id}
                title={t`Ticket info`}
                onClick={() => setInfoOpen(true)}
                className="block max-w-full truncate text-left text-body leading-snug font-semibold text-brand-text"
              >
                {title}
              </Button>
            </h1>
            <span
              className="truncate text-meta text-brand-muted"
              title={ticket.phase ?? undefined}
            >
              {statusLabel(ticket)} · {route}
              {showHandler ? ` · ${t`via ${handlerRepo}`}` : ''}
            </span>
          </div>
        </div>
        {canInspectDiff ? (
          <Button
            variant="ghost"
            size="none"
            type="button"
            aria-haspopup="dialog"
            aria-label={t`Net diff`}
            title={t`Net diff (d)`}
            data-testid="ticket-diff-button"
            onClick={() => setDiffOpen(true)}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl px-2.5 text-caption text-brand-muted"
          >
            <GitCompareArrows size={16} aria-hidden />
            <span className="hidden sm:inline">{t`Diff`}</span>
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          type="button"
          aria-haspopup="dialog"
          aria-label={t`Ticket info`}
          title={t`Ticket info`}
          data-testid="ticket-info-button"
          onClick={() => setInfoOpen(true)}
          className="size-9 shrink-0 rounded-xl text-brand-muted"
        >
          <Info size={18} aria-hidden />
        </Button>
      </div>
      <TicketInfo
        data={data}
        open={infoOpen}
        onClose={() => setInfoOpen(false)}
      />
      <TicketDiffSheet
        ticketId={ticket.id}
        title={title}
        open={diffOpen}
        onClose={() => setDiffOpen(false)}
      />
    </header>
  )
}
