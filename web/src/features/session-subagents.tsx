// What a Claude session's subagents are doing (Agent tool, forked skills such
// as /code-review): the parent transcript only shows a launch line, so the
// host reads each subagent's own transcript (native agent_subagents.go) and
// the session reply carries `subagents`: the running ones (plus stale ones —
// silent, never finished). Like Claude Code's own panel, a subagent leaves
// once it is done; its report is the Agent call's result in the transcript.
// Folded to one line (count + what the first one is doing); tap for the list.
import { useLingui } from '@lingui/react/macro'
import { useEffect, useState } from 'react'

import { Led } from '#/components/deck/led'
import { cn } from '#/lib/utils'
import { Button } from '#/components/ui/button'

export type Subagent = {
  id: string
  name?: string
  description: string
  type: string
  background: boolean
  state: 'running' | 'done' | 'stale'
  tools: number
  last_tool?: string
  started_at?: string
  active_at: number
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m${s % 60}s` : `${Math.floor(m / 60)}h${m % 60}m`
}

function Row({ agent, now }: { agent: Subagent; now: number }) {
  const { t } = useLingui()
  const started = agent.started_at ? Date.parse(agent.started_at) : NaN
  const end = agent.state === 'running' ? now : agent.active_at
  const ran = Number.isNaN(started) ? '' : duration(end - started)
  const tools = agent.tools
  const title = agent.name ? `/${agent.name}` : agent.description
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2 px-3 py-2">
      <span className="pt-1">
        <Led
          tone={
            agent.state === 'running'
              ? 'running'
              : agent.state === 'stale'
                ? 'waiting'
                : 'done'
          }
          size={10}
        />
      </span>
      <span className="grid min-w-0 gap-0.5">
        <span className="flex min-w-0 items-baseline justify-between gap-2">
          <span className="truncate text-body font-medium">{title}</span>
          <span
            data-live
            className="shrink-0 text-meta text-brand-label tabular-nums"
          >
            {ran}
          </span>
        </span>
        <span className="truncate font-mono text-meta text-brand-muted">
          {agent.state === 'stale'
            ? t`No activity for a while`
            : (agent.last_tool ??
              (agent.state === 'done' ? t`Finished` : t`Starting…`))}
        </span>
        <span className="text-meta text-brand-label">
          {agent.type}
          {agent.background ? ` · ${t`background`}` : ''}
          {tools ? ` · ${t`${tools} tool calls`}` : ''}
        </span>
      </span>
    </li>
  )
}

export function SessionSubagents({ agents }: { agents?: Array<Subagent> }) {
  const { t } = useLingui()
  // folded to one line by default: above the composer a full list pushed the
  // conversation off a small screen
  const [open, setOpen] = useState(false)
  // an older relay still lists finished ones: they leave here too
  const list = (agents ?? []).filter((agent) => agent.state !== 'done')
  const running = list.filter((agent) => agent.state === 'running')
  const rest = list.filter((agent) => agent.state === 'stale')
  const now = useNow(running.length > 0)
  if (list.length === 0) return null
  const runningCount = running.length
  const staleCount = rest.length
  const lead = running.at(0)
  const doing = lead ? lead.last_tool || lead.description : ''
  return (
    <section
      data-testid="session-subagents"
      className="overflow-hidden rounded-xl bg-brand-surface"
    >
      <Button
        variant="plain"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex min-h-10 w-full min-w-0 items-center gap-2 px-3 text-left text-caption"
      >
        <Led tone={runningCount ? 'running' : 'waiting'} size={9} />
        <span className="shrink-0 font-medium text-brand-muted">
          {runningCount
            ? t`${runningCount} subagents running`
            : t`${staleCount} subagents silent for a while`}
        </span>
        {doing ? (
          <span className="min-w-0 flex-1 truncate font-mono text-meta text-brand-label">
            {doing}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <span
          aria-hidden
          className={cn('text-brand-label transition', open && 'rotate-90')}
        >
          ›
        </span>
      </Button>
      {open ? (
        <ul className="divide-y divide-brand-edge border-t border-brand-edge">
          {[...running, ...rest].map((agent) => (
            <Row key={agent.id} agent={agent} now={now} />
          ))}
        </ul>
      ) : null}
    </section>
  )
}
