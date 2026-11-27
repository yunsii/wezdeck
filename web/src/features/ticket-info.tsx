// 工单信息: Telegram-profile style 3-tier sheet opened from TicketHeader's
// title or ⓘ button (mirrors session-info.tsx):
//   Header: status LED + full wrapping tap-to-copy title + repo route pills;
//   Tier 1: quick action icon tiles (Copy reference, Take over in tmux);
//   Tier 2: overview FieldList (status, owner, progress, worktree);
//   Tier 3: default-collapsed Technical details (ticket ID, phase, full runs table).
import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import { Check, Copy, SquareTerminal } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { Led } from '#/components/deck/led'
import { Button } from '#/components/ui/button'
import { Disclosure } from '#/components/ui/disclosure'
import { Field, FieldList } from '#/components/ui/field'
import { SectionHeading } from '#/components/ui/section-heading'
import { Sheet } from '#/components/ui/sheet'
import { copyText } from '#/lib/clipboard'
import type { CollabShow } from '#/lib/runtime-contract'
import { hostWrite } from '#/lib/runtime-client'
import { cn } from '#/lib/utils'
import { ticketTone } from './console-collab'
import { useDeviceState } from './device-state'
import { RunMetricsTable } from './ticket-runs'
import { RepoRoute, useOwnerLabel, useStatusLabel } from './tickets-view'

const tileClass =
  'flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl bg-brand-surface px-2 py-2 text-center text-meta font-medium text-brand-text transition-colors hover:bg-brand-soft active:bg-brand-soft disabled:opacity-40'

function hasResumableSession(sessions: Record<string, unknown>) {
  return Object.values(sessions).some(
    (item) =>
      item &&
      typeof item === 'object' &&
      'id' in item &&
      Boolean((item as { id?: unknown }).id),
  )
}

export function TicketInfo({
  data,
  open,
  onClose,
}: {
  data: CollabShow
  open: boolean
  onClose: () => void
}) {
  const { t } = useLingui()
  const client = useQueryClient()
  const device = useDeviceState()
  const statusLabel = useStatusLabel()
  const ownerLabel = useOwnerLabel()
  const [copiedRef, setCopiedRef] = useState(false)
  const [attaching, setAttaching] = useState(false)
  const [attachError, setAttachError] = useState('')
  const ticket = data.ticket
  if (!ticket) return null

  const tone = ticketTone(ticket)
  const fullTitle = ticket.title?.trim() || ticket.id
  const running = ticket.running.length > 0
  const canAttach = hasResumableSession(data.sessions)

  const copyTitle = () => {
    void copyText(fullTitle).then(() => {
      const shown =
        fullTitle.length > 40 ? `${fullTitle.slice(0, 39)}…` : fullTitle
      toast(t`Copied: ${shown}`)
    })
  }

  const copyReference = () => {
    if (!data.reference) return
    void copyText(data.reference).then(() => {
      setCopiedRef(true)
      toast(t`Copied reference`)
      setTimeout(() => setCopiedRef(false), 1_500)
    })
  }

  const attach = async () => {
    setAttaching(true)
    setAttachError('')
    try {
      const result = (await hostWrite('attach', { id: ticket.id })) as {
        tmux_session?: string
        window_name?: string
      }
      const windowName = result.window_name ?? ''
      const tmuxSession = result.tmux_session ?? ''
      toast(t`Opened in tmux: ${windowName} (${tmuxSession})`)
      await client.invalidateQueries({ queryKey: ['runtime', 'collab'] })
      await client.invalidateQueries({ queryKey: ['remote', 'sessions'] })
    } catch (error) {
      setAttachError((error as Error).message)
    } finally {
      setAttaching(false)
    }
  }

  const overviewRows: Array<[string, string]> = [
    [t`Status`, statusLabel(ticket)],
    [t`Owner`, ownerLabel(ticket.owner)],
    [t`Progress`, ticket.progress?.message ?? ''],
    [t`Worktree`, ticket.branch ?? ticket.worktree ?? ''],
  ].filter(([, value]) => Boolean(value) && value !== '—') as Array<
    [string, string]
  >

  const actionCount = (data.reference ? 1 : 0) + (canAttach ? 1 : 0)

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={t`Ticket info`}
      testId="ticket-info"
      className="md:max-w-lg"
    >
      <div className="grid gap-4 px-3 pb-4">
        {/* Profile header: status LED, full tap-to-copy title, route pills */}
        <div className="flex items-start gap-3 px-1">
          <span className="mt-1.5 shrink-0">
            <Led tone={tone} size={14} />
          </span>
          <div className="grid min-w-0 flex-1 gap-1.5">
            <Button
              variant="plain"
              size="none"
              type="button"
              data-testid="ticket-info-title"
              title={t`Copy value`}
              onClick={copyTitle}
              className="text-left text-title leading-snug font-semibold break-words text-brand-text"
            >
              {fullTitle}
            </Button>
            <RepoRoute from={ticket.from} to={ticket.to} />
          </div>
        </div>

        {/* Tier 1: Quick action icon tiles */}
        {actionCount > 0 ? (
          <div className="grid gap-1.5">
            <div
              className={cn(
                'grid gap-2',
                actionCount === 1 ? 'grid-cols-1' : 'grid-cols-2',
              )}
            >
              {data.reference ? (
                <Button
                  variant="plain"
                  size="none"
                  type="button"
                  data-testid="ticket-copy-reference"
                  onClick={copyReference}
                  className={tileClass}
                >
                  <span className="text-brand-muted">
                    {copiedRef ? (
                      <Check
                        size={16}
                        className="text-brand-done"
                        aria-hidden
                      />
                    ) : (
                      <Copy size={16} aria-hidden />
                    )}
                  </span>
                  <span className="max-w-full truncate">
                    {copiedRef ? t`Copied` : t`Copy reference`}
                  </span>
                </Button>
              ) : null}
              {canAttach ? (
                <Button
                  variant="plain"
                  size="none"
                  type="button"
                  data-write
                  data-testid="ticket-attach-button"
                  disabled={attaching || running || device.state !== 'approved'}
                  onClick={() => void attach()}
                  className={tileClass}
                >
                  <span className="text-brand-muted">
                    <SquareTerminal size={16} aria-hidden />
                  </span>
                  <span className="max-w-full truncate">
                    {attaching ? t`Opening…` : t`Take over in tmux`}
                  </span>
                </Button>
              ) : null}
            </div>
            {canAttach && running ? (
              <p className="px-1 text-meta text-brand-muted">
                {t`A headless run is still going; take over when it finishes.`}
              </p>
            ) : null}
            {attachError ? (
              <p role="alert" className="px-1 text-meta text-brand-error">
                {attachError}
              </p>
            ) : null}
          </div>
        ) : null}

        {/* Tier 2: Overview */}
        {overviewRows.length > 0 ? (
          <section className="grid gap-1">
            <SectionHeading className="bg-brand-deck">
              {t`Overview`}
            </SectionHeading>
            <FieldList>
              {overviewRows.map(([label, value]) => (
                <Field key={label} label={label} value={value} />
              ))}
            </FieldList>
          </section>
        ) : null}

        {/* Tier 3: Default-collapsed technical details */}
        <Disclosure
          data-testid="ticket-tech-details"
          title={
            <span className="grid gap-0.5 text-left">
              <span className="text-caption font-medium text-brand-text">
                {t`Technical details`}
              </span>
              <span className="text-meta font-normal text-brand-label">
                {t`Ticket ID and headless run metrics`}
              </span>
            </span>
          }
          triggerClassName="rounded-xl bg-brand-surface px-3 py-2.5 transition-colors hover:bg-brand-soft"
          panelClassName="grid gap-3 pt-2"
        >
          <FieldList>
            <Field label={t`Ticket`} value={ticket.id} mono />
            {ticket.phase ? (
              <Field label={t`Phase`} value={ticket.phase} mono />
            ) : null}
          </FieldList>
          {data.runs.length > 0 ? <RunMetricsTable runs={data.runs} /> : null}
        </Disclosure>
      </div>
    </Sheet>
  )
}
