// Ticket-level lifecycle timeline backed by `ticket api events --ticket <id>`.
// Filters out per-tool stream chatter (which lives inside each RunDetail sheet)
// so scheduling, queue gates, milestones, merges and verify verdicts read as a
// single chronological workflow trail.
import { useLingui } from '@lingui/react/macro'

import { Led } from '#/components/deck/led'
import type { LedTone } from '#/components/deck/led'
import { Disclosure } from '#/components/ui/disclosure'
import { useCollab } from '#/lib/collab-query'
import type { CollabEvent } from '#/lib/runtime-contract'
import { useGateLabel } from './ticket-pipeline'
import { useAgo } from './tickets-view'

const HIDDEN_KINDS = new Set(['tool', 'session_init'])

export function isLifecycleEvent(event: Pick<CollabEvent, 'kind'>): boolean {
  return !HIDDEN_KINDS.has(event.kind)
}

function eventTone(event: CollabEvent): LedTone {
  const row = event as Record<string, unknown>
  switch (event.kind) {
    case 'error':
    case 'proposal_rejected':
      return 'error'
    case 'merge':
      return row.result === 'conflict'
        ? 'error'
        : row.result === 'ok'
          ? 'done'
          : 'muted'
    case 'verify':
      return row.verdict === 'pass'
        ? 'done'
        : row.verdict === 'fail'
          ? 'error'
          : 'muted'
    case 'run_end':
      return row.exit === 0 ? 'done' : row.exit == null ? 'muted' : 'error'
    case 'queued':
    case 'challenge':
    case 'proposal_created':
    case 'warning':
      return 'waiting'
    case 'dispatched':
    case 'scheduler_start':
    case 'run_start':
    case 'milestone':
    case 'implement_start':
      return 'running'
    case 'proposal_approved':
    case 'research_done':
    case 'implement_done':
    case 'scheduler_end':
    case 'closed':
    case 'snapshot':
      return 'done'
    default:
      return 'muted'
  }
}

function clockTime(iso?: string | null): string {
  if (!iso) return ''
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  return new Date(ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function useDescribeEvent(childTitle: (childId: string) => string | undefined) {
  const { t } = useLingui()
  const gateLabel = useGateLabel()
  const childName = (value: unknown) => {
    if (typeof value !== 'string' || !value) return ''
    return childTitle(value) ?? value.slice(-6)
  }

  return (event: CollabEvent): { label: string; detail: string } => {
    const row = event as Record<string, unknown>
    const str = (key: string) => (typeof row[key] === 'string' ? row[key] : '')
    const numVal = (key: string) =>
      typeof row[key] === 'number' ? row[key] : null
    switch (event.kind) {
      case 'scheduler_start': {
        const kids = numVal('children') ?? 0
        const cap = numVal('cap') ?? 0
        return {
          label: t`Scheduler`,
          detail: t`started (${kids} children, cap ${cap})`,
        }
      }
      case 'queued': {
        const who = childName(row.child)
        const why = gateLabel(str('gate'), str('detail'))
        return {
          label: t`Queued`,
          detail: who ? `${who} · ${why}` : why,
        }
      }
      case 'dispatched': {
        const who = childName(row.child)
        const slot = numVal('slot')
        const waitMs = numVal('queue_wait_ms')
        const waitText =
          waitMs && waitMs >= 1000 ? ` (${Math.round(waitMs / 1000)}s)` : ''
        return {
          label: t`Dispatched`,
          detail:
            slot != null
              ? `${who ? `${who} · ` : ''}${t`slot ${slot}`}${waitText}`
              : `${who}${waitText}`,
        }
      }
      case 'child_exit': {
        const who = childName(row.child)
        const st = str('status')
        const rc = numVal('exit')
        return {
          label: t`Child finished`,
          detail: `${who} · ${st || `exit ${rc ?? '?'}`}`,
        }
      }
      case 'retry': {
        const who = childName(row.child)
        return {
          label: t`Retry`,
          detail: who || str('status'),
        }
      }
      case 'milestone':
        return { label: t`Progress`, detail: str('text') }
      case 'snapshot': {
        const who = childName(row.child)
        const files = numVal('files') ?? 0
        return {
          label: t`Snapshot`,
          detail: `${who} · ${t`${files} file(s)`}`,
        }
      }
      case 'merge': {
        const repo = str('repo')
        const res = str('result')
        const files = Array.isArray(row.files)
          ? row.files.map(String).join(', ')
          : ''
        return {
          label: t`Merge`,
          detail: [repo, res, files].filter(Boolean).join(' · '),
        }
      }
      case 'verify': {
        const verdict = str('verdict')
        const findings = Array.isArray(row.findings)
          ? row.findings.map(String).join('; ')
          : ''
        return {
          label: t`Verify`,
          detail: [verdict, findings].filter(Boolean).join(' · '),
        }
      }
      case 'scheduler_end':
        return {
          label: t`Scheduler ended`,
          detail: str('result') || str('status'),
        }
      case 'proposal_created':
        return {
          label: t`Proposal`,
          detail: `${str('proposal')} (${str('origin')})`,
        }
      case 'proposal_approved':
        return { label: t`Approved`, detail: str('proposal') }
      case 'proposal_rejected':
        return {
          label: t`Rejected`,
          detail: [str('proposal'), str('reason')].filter(Boolean).join(' · '),
        }
      case 'worktree_ready':
        return {
          label: t`Worktree`,
          detail: str('branch') || str('worktree'),
        }
      case 'run_start':
        return {
          label: t`Run started`,
          detail: [str('backend'), str('reuse')].filter(Boolean).join(' · '),
        }
      case 'run_end': {
        const rc = numVal('exit')
        const turns = numVal('turns')
        return {
          label: t`Run ended`,
          detail: `exit ${rc ?? '?'}${turns != null ? ` · ${turns} turns` : ''}`,
        }
      }
      case 'research_done':
        return {
          label: t`Research done`,
          detail: str('verdict') || str('status'),
        }
      case 'implement_start':
        return { label: t`Implement`, detail: str('backend') }
      case 'implement_done':
        return {
          label: t`Implement done`,
          detail: str('status') || str('next_action'),
        }
      case 'challenge':
        return { label: t`Challenge`, detail: str('needs') || str('measured') }
      case 'reply':
        return { label: t`Reply`, detail: str('decision') }
      case 'from_changed':
        return {
          label: t`Source changed`,
          detail: `${str('old_from') || '?'} → ${str('new_from') || '?'}`,
        }
      case 'handler_changed': {
        const oldRepo = str('old_repo')
        const newRepo = str('new_repo') || '—'
        const via = str('via')
        const routeText = oldRepo ? `${oldRepo} → ${newRepo}` : newRepo
        return {
          label: t`Handler changed`,
          detail: via ? `${routeText} (${via})` : routeText,
        }
      }
      case 'error':
      case 'warning':
        return {
          label: event.kind === 'error' ? t`Error` : t`Warning`,
          detail: [str('where'), str('message')].filter(Boolean).join(': '),
        }
      default:
        return {
          label: event.kind,
          detail:
            str('message') ||
            str('status') ||
            str('step') ||
            childName(row.child),
        }
    }
  }
}

export function TicketTimeline({
  id,
  active,
  poll,
  childTitle,
}: {
  id: string
  active: boolean
  poll: number
  childTitle: (childId: string) => string | undefined
}) {
  const { t } = useLingui()
  const ago = useAgo()
  const describe = useDescribeEvent(childTitle)
  const query = useCollab(
    'events',
    { ticket: id, after: 0, limit: 200 },
    { refetchInterval: active ? poll : undefined },
  )
  const rawEvents = query.data?.ok ? query.data.events : []
  const events = rawEvents.filter(isLifecycleEvent)
  if (events.length === 0) return null

  const latest = describe(events[events.length - 1])
  const latestTs = events[events.length - 1]?.ts

  return (
    <Disclosure
      data-testid="ticket-timeline"
      defaultOpen={false}
      triggerClassName="rounded-xl border border-brand-border bg-brand-surface px-3 py-2.5 transition-colors hover:bg-brand-soft"
      panelClassName="pt-2"
      title={
        <span className="grid min-w-0 flex-1 gap-0.5 text-left">
          <span className="flex items-center gap-2 text-caption font-medium text-brand-text">
            <span>{t`Workflow timeline`}</span>
            <span className="font-mono text-meta font-normal text-brand-label tabular-nums">
              {events.length}
            </span>
            {latestTs ? (
              <span className="ml-auto font-mono text-meta font-normal text-brand-label tabular-nums">
                {ago(latestTs)}
              </span>
            ) : null}
          </span>
          <span className="truncate text-meta font-normal text-brand-muted">
            {latest.label}
            {latest.detail ? ` · ${latest.detail}` : ''}
          </span>
        </span>
      }
    >
      <ol
        aria-label={t`Workflow timeline`}
        className="grid max-h-80 gap-px overflow-auto rounded-xl border border-brand-border bg-brand-border font-mono text-meta"
      >
        {events.map((event, index) => {
          const item = describe(event)
          return (
            <li
              key={`${event.seq ?? index}-${event.kind}`}
              className="grid grid-cols-[auto_5.5rem_minmax(0,1fr)_auto] items-baseline gap-2 bg-brand-deck px-2.5 py-1.5"
            >
              <span className="self-center">
                <Led tone={eventTone(event)} size={8} />
              </span>
              <span className="truncate text-brand-label">{item.label}</span>
              <span className="break-words text-brand-muted">
                {item.detail || '—'}
              </span>
              <span className="shrink-0 text-brand-label tabular-nums">
                {clockTime(event.ts)}
              </span>
            </li>
          )
        })}
      </ol>
    </Disclosure>
  )
}
