// End-to-end ticket workflow progress stepper + live progress banner.
// Derives ordered lifecycle stages from `api show` (parent / research /
// child / standalone) without inventing new backend state files.
import { useLingui } from '@lingui/react/macro'
import { ChevronRight } from 'lucide-react'

import { Led } from '#/components/deck/led'
import type { LedTone } from '#/components/deck/led'
import type { CollabShow } from '#/lib/runtime-contract'
import { cn } from '#/lib/utils'
import { useAgo } from './tickets-view'

export type PipelineStepId =
  | 'plan'
  | 'review'
  | 'dispatch'
  | 'merge'
  | 'verify'
  | 'checkout'
  | 'submitted'
  | 'worktree'
  | 'research'
  | 'implement'
  | 'done'

export type PipelineStep = {
  id: PipelineStepId
  tone: LedTone
  count?: string
  current?: boolean
}

const TERMINAL_DONE = new Set(['shipped', 'closed'])
const TERMINAL_ERR = new Set(['failed', 'rejected'])

function isParentTicket(data: CollabShow): boolean {
  return (
    data.ticket?.kind === 'parent' ||
    data.collab?.kind === 'parent' ||
    data.children_detail.length > 0 ||
    data.proposals.length > 0
  )
}

function buildParentSteps(data: CollabShow): Array<PipelineStep> {
  const ticket = data.ticket
  const status = ticket?.status ?? ''
  const phase = ticket?.phase ?? ''
  const kids = data.children_detail
  const doneKids = kids.filter((c) => TERMINAL_DONE.has(c.status ?? '')).length
  const runningKids = kids.filter((c) => c.running.length > 0).length
  const failedKids = kids.filter((c) => TERMINAL_ERR.has(c.status ?? '')).length
  const waitingKids = kids.filter(
    (c) => c.status === 'waiting_initiator',
  ).length
  const count = kids.length > 0 ? `${doneKids}/${kids.length}` : undefined
  const schedulerAlive = Boolean(data.collab?.scheduler?.alive)

  const steps: Array<PipelineStep> = [
    { id: 'plan', tone: 'done' },
    { id: 'review', tone: 'muted' },
    { id: 'dispatch', tone: 'muted', count },
    { id: 'merge', tone: 'muted' },
    { id: 'verify', tone: 'muted' },
    { id: 'done', tone: 'muted' },
  ]
  const at = (id: PipelineStepId) => steps.find((s) => s.id === id)!
  const markDone = (...ids: Array<PipelineStepId>) => {
    for (const id of ids) at(id).tone = 'done'
  }
  const focus = (id: PipelineStepId, tone: LedTone) => {
    const s = at(id)
    s.tone = tone
    s.current = true
  }

  if (
    phase === 'plan_review' ||
    data.proposals.some((p) => p.origin === 'draft')
  ) {
    focus('review', 'waiting')
    return steps
  }
  if (phase === 'plan_rejected' || status === 'rejected') {
    focus('review', 'error')
    return steps
  }
  markDone('review')

  if (phase === 'done' || status === 'shipped' || status === 'closed') {
    if (phase === 'done_unmerged') {
      markDone('dispatch', 'done')
      at('merge').tone = 'muted'
      at('verify').tone = 'muted'
      at('done').current = true
    } else {
      markDone('dispatch', 'merge', 'verify', 'done')
      at('done').current = true
    }
    return steps
  }
  if (phase === 'verify_failed') {
    markDone('dispatch', 'merge')
    focus('verify', 'error')
    return steps
  }
  if (phase === 'integration_conflict') {
    markDone('dispatch')
    focus('merge', 'error')
    return steps
  }
  if (phase === 'integrating') {
    markDone('dispatch')
    const hasMerged =
      data.collab?.integration &&
      Object.values(data.collab.integration).some((i) => i.merged.length > 0)
    if (hasMerged && (ticket?.running.length ?? 0) > 0) {
      markDone('merge')
      focus('verify', 'running')
    } else {
      focus('merge', 'running')
    }
    return steps
  }
  if (phase === 'children_done') {
    markDone('dispatch')
    focus('merge', 'waiting')
    return steps
  }
  if (
    phase === 'split_review' ||
    data.proposals.some((p) => p.origin === 'split')
  ) {
    focus('dispatch', 'waiting')
    return steps
  }
  if (phase === 'running' || schedulerAlive || runningKids > 0) {
    if (
      status === 'failed' ||
      (failedKids > 0 && !schedulerAlive && runningKids === 0)
    ) {
      focus('dispatch', 'error')
    } else if (
      status === 'waiting_initiator' ||
      (waitingKids > 0 && !schedulerAlive && runningKids === 0)
    ) {
      focus('dispatch', 'waiting')
    } else {
      focus('dispatch', 'running')
    }
    return steps
  }
  // planning (approved, waiting to start or children created)
  focus('dispatch', status === 'failed' ? 'error' : 'muted')
  return steps
}

function buildResearchSteps(data: CollabShow): Array<PipelineStep> {
  const ticket = data.ticket
  const status = ticket?.status ?? ''
  const phase = ticket?.phase ?? ''
  const running = (ticket?.running.length ?? 0) > 0
  if (
    status === 'shipped' ||
    status === 'closed' ||
    phase === 'research_done'
  ) {
    return [
      { id: 'checkout', tone: 'done' },
      { id: 'research', tone: 'done' },
      { id: 'done', tone: 'done', current: true },
    ]
  }
  if (
    status === 'failed' ||
    status === 'rejected' ||
    phase === 'research_failed'
  ) {
    return [
      { id: 'checkout', tone: 'done' },
      { id: 'research', tone: 'error', current: true },
      { id: 'done', tone: 'muted' },
    ]
  }
  return [
    { id: 'checkout', tone: 'done' },
    {
      id: 'research',
      tone: running || status === 'in_progress' ? 'running' : 'muted',
      current: true,
    },
    { id: 'done', tone: 'muted' },
  ]
}

function buildTicketWorkSteps(data: CollabShow): Array<PipelineStep> {
  const ticket = data.ticket
  const status = ticket?.status ?? ''
  const phase = ticket?.phase ?? ''
  const step = ticket?.progress?.step ?? ''
  const running = (ticket?.running.length ?? 0) > 0
  const hasWorktree = Boolean(ticket?.worktree || ticket?.branch)
  const hasResearchRun = data.runs.some((r) => r.phase === 'research')
  const hasImplRun = data.runs.some((r) => r.phase === 'implement')

  const steps: Array<PipelineStep> = [
    { id: 'submitted', tone: 'done' },
    { id: 'worktree', tone: hasWorktree ? 'done' : 'muted' },
    { id: 'research', tone: 'muted' },
    { id: 'implement', tone: 'muted' },
    { id: 'done', tone: 'muted' },
  ]
  const at = (id: PipelineStepId) => steps.find((s) => s.id === id)!
  const focus = (id: PipelineStepId, tone: LedTone) => {
    const s = at(id)
    s.tone = tone
    s.current = true
  }

  if (TERMINAL_DONE.has(status)) {
    at('worktree').tone = 'done'
    at('research').tone = 'done'
    at('implement').tone = 'done'
    focus('done', 'done')
    return steps
  }
  if (TERMINAL_ERR.has(status)) {
    const active: PipelineStepId =
      hasImplRun || phase === 'implementing' || step.startsWith('implement')
        ? 'implement'
        : hasResearchRun ||
            phase === 'researching' ||
            step.startsWith('research')
          ? 'research'
          : 'submitted'
    if (active === 'implement') {
      at('worktree').tone = 'done'
      at('research').tone = 'done'
    } else if (active === 'research') {
      at('worktree').tone = 'done'
    }
    focus(active, 'error')
    return steps
  }
  if (
    phase === 'implementing' ||
    step === 'implement_start' ||
    step === 'implement_done' ||
    hasImplRun
  ) {
    at('worktree').tone = 'done'
    at('research').tone = 'done'
    focus(
      'implement',
      status === 'waiting_initiator'
        ? 'waiting'
        : running || status === 'in_progress'
          ? 'running'
          : 'muted',
    )
    return steps
  }
  if (
    phase === 'researching' ||
    step === 'research_start' ||
    step === 'research_done' ||
    hasResearchRun ||
    status === 'waiting_initiator'
  ) {
    if (hasWorktree || step === 'research_start' || hasResearchRun) {
      at('worktree').tone = 'done'
    }
    focus(
      'research',
      status === 'waiting_initiator'
        ? 'waiting'
        : running || status === 'in_progress'
          ? 'running'
          : 'muted',
    )
    return steps
  }
  if (step === 'worktree_ready' || hasWorktree) {
    at('worktree').tone = 'done'
    focus('research', running ? 'running' : 'muted')
    return steps
  }
  if (step === 'queued') {
    focus('submitted', 'waiting')
    return steps
  }
  focus('submitted', running || status === 'in_progress' ? 'running' : 'muted')
  return steps
}

export function buildTicketSteps(data: CollabShow): Array<PipelineStep> {
  if (!data.ticket) return []
  if (isParentTicket(data)) return buildParentSteps(data)
  if (data.ticket.kind === 'research') return buildResearchSteps(data)
  return buildTicketWorkSteps(data)
}

export function useGateLabel() {
  const { t } = useLingui()
  const labels: Record<string, string> = {
    deps: t`Waiting on dependencies`,
    path_overlap: t`Waiting on overlapping scope`,
    mem: t`Waiting on memory gate`,
    slot: t`Waiting on parallel slot`,
    repo_cap: t`Waiting on repo cap`,
    session: t`Held by interactive session`,
    blocked: t`Blocked by dependency`,
  }
  return (gate?: string | null, detail?: string | null) => {
    if (!gate) return ''
    const base = labels[gate] ?? gate
    return detail ? `${base} · ${detail}` : base
  }
}

export function TicketPipeline({ data }: { data: CollabShow }) {
  const { t } = useLingui()
  const ago = useAgo()
  const ticket = data.ticket
  if (!ticket) return null
  const steps = buildTicketSteps(data)
  const labels: Record<PipelineStepId, string> = {
    plan: t`Plan`,
    review: t`Approval`,
    dispatch: t`Workers`,
    merge: t`Merge`,
    verify: t`Verify`,
    checkout: t`Checkout`,
    submitted: t`Queued`,
    worktree: t`Worktree`,
    research: t`Research`,
    implement: t`Implement`,
    done: t`Done`,
  }
  const schedulerAlive = Boolean(data.collab?.scheduler?.alive)
  const progressText = ticket.progress?.message?.trim() ?? ''
  const milestoneText = ticket.last_milestone?.text.trim() ?? ''
  const liveText =
    milestoneText && milestoneText !== progressText
      ? progressText
        ? `${progressText} · ${milestoneText}`
        : milestoneText
      : progressText || milestoneText
  const liveTs = ticket.last_milestone?.ts ?? ticket.progress?.ts

  return (
    <section
      aria-label={t`Workflow progress`}
      data-testid="ticket-pipeline"
      className="grid gap-2 rounded-xl border border-brand-border bg-brand-surface px-3 py-2.5"
    >
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-1.5">
        {steps.map((step, index) => (
          <li key={step.id} className="flex items-center gap-1">
            {index > 0 ? (
              <ChevronRight
                size={12}
                aria-hidden
                className="shrink-0 text-brand-border"
              />
            ) : null}
            <span
              data-step={step.id}
              data-step-tone={step.tone}
              aria-current={step.current ? 'step' : undefined}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-meta tabular-nums',
                step.current
                  ? 'bg-brand-deck font-medium text-brand-text ring-1 ring-brand-border'
                  : step.tone === 'done'
                    ? 'text-brand-muted'
                    : 'text-brand-label',
              )}
            >
              <Led tone={step.tone} size={9} />
              <span>{labels[step.id]}</span>
              {step.count ? (
                <span className="font-mono text-brand-label">{step.count}</span>
              ) : null}
            </span>
          </li>
        ))}
        {schedulerAlive ? (
          <li className="ml-auto flex items-center gap-1.5 rounded-md bg-brand-running/10 px-2 py-0.5 text-meta font-medium text-brand-running">
            <Led tone="running" size={8} />
            <span>{t`Scheduler active`}</span>
          </li>
        ) : null}
      </ol>
      {liveText ? (
        <div
          data-testid="ticket-pipeline-progress"
          className="flex min-w-0 items-baseline justify-between gap-2 border-t border-brand-border/60 pt-1.5 text-meta"
        >
          <span className="min-w-0 truncate text-brand-muted" title={liveText}>
            {liveText}
          </span>
          {liveTs ? (
            <span className="shrink-0 font-mono text-brand-label tabular-nums">
              {ago(liveTs)}
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
