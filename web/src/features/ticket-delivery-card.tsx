// Integration & verify=pass delivery checklist card for parent tickets (P4).
// Surfaces merge conflicts, verification failures, or ready-to-deliver
// integration branches with one-tap Diff inspection and delivery confirmation.
import { useLingui } from '@lingui/react/macro'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  CheckCircle2,
  FileDiff,
  GitBranch,
  Send,
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import { trace } from '#/lib/client-trace'
import { collabKey } from '#/lib/collab-query'
import { hostWrite } from '#/lib/runtime-client'
import type { CollabShow } from '#/lib/runtime-contract'
import { cn } from '#/lib/utils'
import { useDeviceState } from './device-state'
import { TicketDiffSheet } from './ticket-diff'

type IntegrationMap = NonNullable<
  NonNullable<CollabShow['collab']>['integration']
>

export function TicketDeliveryCard({
  data,
}: {
  data: CollabShow & { ticket: NonNullable<CollabShow['ticket']> }
}) {
  const { t } = useLingui()
  const device = useDeviceState()
  const client = useQueryClient()
  const [diffOpen, setDiffOpen] = useState(false)
  const integration: IntegrationMap | null | undefined =
    data.collab?.integration
  if (!integration || Object.keys(integration).length === 0) return null

  const ticket = data.ticket
  const canWrite = device.state === 'approved'
  const hasManager = Boolean(ticket.manager_session)
  const entries = Object.entries(integration)
  const conflicts = entries.filter(([, info]) => Boolean(info.conflict))
  const mergedRepos = entries.filter(
    ([, info]) => !info.conflict && !info.skipped && info.merged.length > 0,
  )
  const verifyFailed = ticket.phase === 'verify_failed'
  const hasConflict =
    conflicts.length > 0 || ticket.phase === 'integration_conflict'
  const isClosed = ticket.status === 'closed'
  const readyToDeliver = !hasConflict && !verifyFailed && mergedRepos.length > 0

  const sendAction = useMutation({
    mutationFn: async (kind: 'deliver' | 'fix') => {
      const repoSummary = mergedRepos
        .map(([repo, info]) => `${repo} (${info.branch ?? 'integration'})`)
        .join(', ')
      const text =
        kind === 'deliver'
          ? `Delivery confirmed by user for ${ticket.id} (${repoSummary}). Follow repository delivery policy: for business repos push the integration branch and open a draft/review MR without auto-merging; for personal repos land onto mainline if verified, then close this ticket.`
          : hasConflict
            ? `Please inspect and resolve the integration merge conflict on ${ticket.id}, re-run verification, and report back.`
            : `Please inspect the failed integration verification on ${ticket.id}, fix the issue, re-verify, and report back.`
      if (hasManager) {
        return hostWrite('ticket.manager.send', { id: ticket.id, text })
      }
      return hostWrite('reply', {
        id: ticket.id,
        decision: text,
        continue: true,
      })
    },
    onSuccess: (_res, kind) => {
      if (kind === 'deliver') {
        trace('deliver-confirmed', {
          id: ticket.id,
          repos: mergedRepos.length,
        })
        toast(t`Delivery confirmation sent`)
      } else {
        toast(t`Fix request sent`)
      }
      void client.invalidateQueries({
        queryKey: collabKey('show', { id: ticket.id }),
      })
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : String(err))
    },
  })

  return (
    <>
      <section
        aria-label={t`Integration delivery`}
        data-testid="ticket-delivery-card"
        className={cn(
          'grid gap-3 rounded-2xl border p-4',
          hasConflict || verifyFailed
            ? 'border-brand-error/40 bg-brand-error/5'
            : readyToDeliver && !isClosed
              ? 'border-brand-done/40 bg-brand-done/5'
              : 'border-brand-edge bg-brand-surface',
        )}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {hasConflict || verifyFailed ? (
              <AlertTriangle
                size={16}
                aria-hidden
                className="shrink-0 text-brand-error"
              />
            ) : (
              <CheckCircle2
                size={16}
                aria-hidden
                className="shrink-0 text-brand-done"
              />
            )}
            <h2 className="text-body font-semibold text-brand-text">
              {hasConflict
                ? t`Integration merge conflict`
                : verifyFailed
                  ? t`Integration verification failed`
                  : isClosed
                    ? t`Delivered`
                    : t`Ready to deliver`}
            </h2>
          </div>
          <Button
            variant="outline"
            size="sm"
            type="button"
            data-testid="delivery-open-diff"
            onClick={() => setDiffOpen(true)}
            className="inline-flex items-center gap-1.5"
          >
            <FileDiff size={14} aria-hidden />
            <span>{t`Review net diff`}</span>
          </Button>
        </div>

        <ul className="grid gap-1.5">
          {entries.map(([repo, info]) => {
            const mergedCount = info.merged.length
            return (
              <li
                key={repo}
                className="flex flex-wrap items-center gap-2 rounded-xl border border-brand-edge/80 bg-brand-surface px-3 py-2 font-mono text-meta"
              >
                <span className="font-semibold text-brand-text">{repo}</span>
                {info.conflict ? (
                  <span className="text-brand-error">
                    {t`conflict`}: {info.conflict.files.join(', ')}
                  </span>
                ) : info.skipped ? (
                  <span className="text-brand-muted">{info.skipped}</span>
                ) : (
                  <>
                    <span className="inline-flex items-center gap-1 rounded-full bg-brand-deck px-2 py-0.5 text-brand-muted">
                      <GitBranch size={11} aria-hidden />
                      {info.branch ?? ''}
                    </span>
                    <span className="text-brand-done">
                      {t`${mergedCount} merged`}
                    </span>
                  </>
                )}
              </li>
            )
          })}
        </ul>

        {readyToDeliver && !isClosed ? (
          <p className="text-meta text-brand-muted">
            {t`Delivery policy: business repos push branch and open a draft MR (never auto-merge); personal repos land onto mainline after verification.`}
          </p>
        ) : null}

        {canWrite && !isClosed ? (
          <div className="flex flex-wrap items-center gap-2">
            {readyToDeliver ? (
              <Button
                variant="solid"
                type="button"
                data-testid="delivery-confirm-button"
                disabled={sendAction.isPending}
                onClick={() => sendAction.mutate('deliver')}
                className="inline-flex min-h-10 items-center gap-1.5"
              >
                <Send size={14} aria-hidden />
                <span>
                  {sendAction.isPending
                    ? t`Sending…`
                    : t`Confirm delivery & close`}
                </span>
              </Button>
            ) : hasConflict || verifyFailed ? (
              <Button
                variant="solid"
                type="button"
                data-testid="delivery-fix-button"
                disabled={sendAction.isPending}
                onClick={() => sendAction.mutate('fix')}
                className="inline-flex min-h-10 items-center gap-1.5"
              >
                <Send size={14} aria-hidden />
                <span>
                  {sendAction.isPending
                    ? t`Sending…`
                    : hasConflict
                      ? t`Ask manager to resolve conflict`
                      : t`Ask manager to fix verification`}
                </span>
              </Button>
            ) : null}
          </div>
        ) : null}
      </section>

      <TicketDiffSheet
        ticketId={ticket.id}
        title={ticket.title || ticket.id}
        hasManager={hasManager}
        open={diffOpen}
        onClose={() => setDiffOpen(false)}
      />
    </>
  )
}
