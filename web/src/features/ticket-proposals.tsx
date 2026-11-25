// Fan-out splits awaiting the user (skills/agent-collab/lib/split.py): a
// plan agent's draft (contract + children) or a running child's proposed
// sibling. Nothing is created until someone confirms here or in chat; the
// tap rides on the `reply` write (proposal + verdict → `ticket fanout
// approve --run` / `reject`), so the Runtime's write allowlist is unchanged.
import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'

import { hostWrite } from '#/lib/runtime-client'
import type { TicketProposal } from '#/lib/runtime-contract'
import { Button } from '#/components/ui/button'
import { Disclosure } from '#/components/ui/disclosure'
import { Textarea } from '#/components/ui/textarea'
import { useDeviceState } from './device-state'

/** `depends_on` keys / ids → readable names (sibling items, else existing children) */
export function dependsLabel(
  deps: Array<string>,
  items: TicketProposal['items'],
  childTitle: (id: string) => string | undefined,
) {
  return deps
    .map(
      (d) =>
        items.find((item) => item.key === d)?.title ??
        childTitle(d) ??
        d.slice(-6),
    )
    .join(', ')
}

export function TicketProposals({
  id,
  proposals,
  childTitle,
}: {
  id: string
  proposals: Array<TicketProposal>
  childTitle: (id: string) => string | undefined
}) {
  if (proposals.length === 0) return null
  return (
    <div className="grid gap-3">
      {proposals.map((proposal) => (
        <ProposalCard
          key={proposal.id}
          id={id}
          proposal={proposal}
          childTitle={childTitle}
        />
      ))}
    </div>
  )
}

function ProposalCard({
  id,
  proposal,
  childTitle,
}: {
  id: string
  proposal: TicketProposal
  childTitle: (id: string) => string | undefined
}) {
  const { t } = useLingui()
  const client = useQueryClient()
  const device = useDeviceState()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const n = proposal.items.length
  const pid = proposal.id
  const by = proposal.by ? (childTitle(proposal.by) ?? proposal.by) : ''
  const approved = device.state === 'approved'
  const decide = async (verdict: 'approve' | 'reject') => {
    setBusy(true)
    setError('')
    try {
      await hostWrite('reply', {
        id,
        proposal: proposal.id,
        verdict,
        text: verdict === 'reject' ? reason : '',
      })
      toast(
        verdict === 'approve'
          ? t`Confirmed: ${n} child ticket(s) created, scheduler started`
          : t`Proposal rejected`,
      )
      await client.invalidateQueries({ queryKey: ['runtime', 'collab'] })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      aria-label={t`Split proposal ${pid}`}
      className="grid gap-3 rounded-2xl bg-brand-surface p-4"
    >
      <header className="grid gap-1">
        <h2 className="text-body font-semibold">
          {proposal.origin === 'draft'
            ? t`Proposed plan: ${n} child ticket(s)`
            : t`${by} proposes splitting off a ticket`}
        </h2>
        <p className="text-meta text-brand-muted">
          {t`Nothing is created until you confirm.`}
        </p>
      </header>
      {proposal.reason ? (
        <p className="text-caption leading-relaxed whitespace-pre-wrap">
          {proposal.reason}
        </p>
      ) : null}
      {(proposal.warnings ?? []).map((warning) => (
        <p key={warning} className="text-meta text-brand-waiting">
          {warning}
        </p>
      ))}
      {proposal.contract ? (
        <Disclosure
          className="border-y border-brand-edge"
          triggerClassName="min-h-11 text-caption font-medium"
          title={t`Contract`}
        >
          <p className="pb-3 text-caption leading-relaxed whitespace-pre-wrap text-brand-muted">
            {proposal.contract}
          </p>
        </Disclosure>
      ) : null}
      <ol className="grid">
        {proposal.items.map((item) => (
          <li
            key={item.key}
            className="grid gap-0.5 border-b border-brand-edge py-2 last:border-b-0"
          >
            <span className="text-caption font-medium">{item.title}</span>
            <span className="font-mono text-meta text-brand-muted">
              {item.to} · {item.scope.join(', ') || '*'}
              {item.depends_on.length > 0
                ? ` · ${t`after`} ${dependsLabel(item.depends_on, proposal.items, childTitle)}`
                : ''}
            </span>
            {item.assumed ? (
              <span className="text-meta leading-relaxed text-brand-muted">
                {item.assumed}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
      {!approved ? (
        <p className="text-meta text-brand-muted">
          {t`This device is not approved yet (Settings › Device access).`}
        </p>
      ) : null}
      {rejecting ? (
        <>
          <label htmlFor={`reject-${proposal.id}`} className="sr-only">
            {t`Why reject`}
          </label>
          <Textarea
            id={`reject-${proposal.id}`}
            autoFocus
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                (event.ctrlKey || event.metaKey) &&
                reason.trim() &&
                !busy
              ) {
                event.preventDefault()
                void decide('reject')
              } else if (event.key === 'Escape') {
                setRejecting(false)
              }
            }}
            rows={2}
            placeholder={t`Why — the planner reads this (required)`}
            className="min-h-20 rounded-xl bg-brand-deck text-body"
          />
        </>
      ) : null}
      {error ? (
        <p role="alert" className="text-meta text-brand-error">
          {error}
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        {rejecting ? (
          <>
            <Button
              variant="plain"
              type="button"
              disabled={busy}
              onClick={() => setRejecting(false)}
              className="key-press min-h-11 rounded-xl text-body"
            >
              {t`Cancel`}
            </Button>
            <Button
              variant="solid"
              type="button"
              disabled={busy || !reason.trim() || !approved}
              onClick={() => void decide('reject')}
              className="min-h-11 text-body disabled:opacity-40"
            >
              {t`Reject`}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="plain"
              type="button"
              disabled={busy || !approved}
              onClick={() => setRejecting(true)}
              className="key-press min-h-11 rounded-xl text-body disabled:opacity-40"
            >
              {t`Reject…`}
            </Button>
            <Button
              variant="solid"
              type="button"
              disabled={busy || !approved}
              onClick={() => void decide('approve')}
              className="min-h-11 text-body disabled:opacity-40"
            >
              {t`Confirm and start`}
            </Button>
          </>
        )}
      </div>
    </section>
  )
}
