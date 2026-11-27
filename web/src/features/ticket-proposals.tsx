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
import { cn } from '#/lib/utils'
import type { TicketProposal } from '#/lib/runtime-contract'
import { Button } from '#/components/ui/button'
import { Disclosure } from '#/components/ui/disclosure'
import { Textarea } from '#/components/ui/textarea'
import { ChatMarkdown } from './chat-markdown'
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
      <Part title={t`What it solves`}>
        <ChatMarkdown
          text={proposal.summary?.problem ?? proposal.reason ?? ''}
          className="text-caption"
        />
      </Part>
      {(proposal.status_check ?? []).length > 0 ? (
        <Part title={t`What already exists`}>
          <StatusCheck checks={proposal.status_check ?? []} />
        </Part>
      ) : null}
      <Part title={t`How it will be done`}>
        {proposal.summary?.approach ? (
          <ChatMarkdown
            text={proposal.summary.approach}
            className="text-caption"
          />
        ) : null}
        <ol className="grid">
          {proposal.items.map((item) => (
            <li
              key={item.key}
              className="grid gap-0.5 border-b border-brand-edge py-2 last:border-b-0"
            >
              <span className="text-caption font-medium">{item.title}</span>
              {item.effect ? (
                <span className="text-caption leading-relaxed">
                  {item.effect}
                </span>
              ) : null}
              <span className="font-mono text-meta text-brand-muted">
                {item.to} · {item.scope.join(', ') || '*'}
                {item.depends_on.length > 0
                  ? ` · ${t`after`} ${dependsLabel(item.depends_on, proposal.items, childTitle)}`
                  : ''}
              </span>
            </li>
          ))}
        </ol>
      </Part>
      {proposal.outcome ? (
        <Part title={t`What confirming starts`}>
          <Outcome outcome={proposal.outcome} risks={proposal.risks ?? []} />
        </Part>
      ) : null}
      {(proposal.warnings ?? []).map((warning) => (
        <p key={warning} className="text-meta text-brand-waiting">
          {warning}
        </p>
      ))}
      <Disclosure
        className="border-y border-brand-edge"
        triggerClassName="min-h-11 text-caption font-medium"
        title={t`Technical details`}
      >
        <div className="grid gap-2 pb-3 text-caption leading-relaxed text-brand-muted">
          {proposal.contract ? (
            <ChatMarkdown text={proposal.contract} className="text-caption" />
          ) : null}
          {proposal.items.map((item) =>
            item.assumed ? (
              <p key={item.key}>
                <span className="font-medium">{item.title}</span>
                {': '}
                {item.assumed}
              </p>
            ) : null,
          )}
        </div>
      </Disclosure>
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

function Part({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="grid gap-1.5 border-t border-brand-edge pt-3">
      <h3 className="text-meta font-medium text-brand-label">{title}</h3>
      {children}
    </div>
  )
}

/** what confirming starts: computed by split.py from this machine's records */
function Outcome({
  outcome,
  risks,
}: {
  outcome: NonNullable<TicketProposal['outcome']>
  risks: Array<string>
}) {
  const { t } = useLingui()
  const workers = outcome.workers
  const parallel = outcome.max_parallel
  const stages = outcome.stages
  const minLow = outcome.minutes_each[0] ?? 0
  const minHigh = outcome.minutes_each[1] ?? minLow
  const gb = (outcome.mem_peak_mb / 1024).toFixed(1)
  const where = Object.entries(outcome.delivery)
    .map(([repo, branch]) => `${repo} · ${branch}`)
    .join('; ')
  return (
    <ul className="grid gap-1 text-caption leading-relaxed">
      <li>{t`${workers} background worker(s), at most ${parallel} at once, in ${stages} stage(s)`}</li>
      <li>{t`About ${minLow}–${minHigh} min each, memory peak about ${gb} GB`}</li>
      <li>{t`Lands on ${where}; nothing is pushed and no MR is opened`}</li>
      {risks.map((risk) => (
        <li key={risk} className="text-brand-waiting">
          {t`May stop to ask you:`} {risk}
        </li>
      ))}
      <li className="text-meta text-brand-muted">
        {t`Estimated from this machine's past runs, not by the planner.`}
      </li>
    </ul>
  )
}

/** each goal item vs the target's default branch, with the planner's evidence */
function StatusCheck({
  checks,
}: {
  checks: NonNullable<TicketProposal['status_check']>
}) {
  const { t } = useLingui()
  const label = {
    missing: t`not done`,
    partial: t`partly done`,
    done: t`already done`,
  }
  const mark = { missing: '✗', partial: '~', done: '✓' }
  return (
    <ul className="grid gap-1.5">
      {checks.map((check) => (
        <li key={check.item} className="grid gap-0.5">
          <span className="text-caption">
            <span
              aria-hidden
              className={cn(
                'mr-1.5 font-mono',
                check.status === 'done' && 'text-brand-running',
                check.status === 'partial' && 'text-brand-waiting',
                check.status === 'missing' && 'text-brand-muted',
              )}
            >
              {mark[check.status]}
            </span>
            {label[check.status]} · {check.item}
          </span>
          <span className="font-mono text-meta break-all text-brand-muted">
            {check.evidence}
          </span>
          {check.reuse ? (
            <span className="text-meta text-brand-muted">
              {t`Reuses`} {check.reuse}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
