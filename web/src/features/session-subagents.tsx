// What a Claude session's subagents are doing (Agent tool, forked skills such
// as /code-review): the parent transcript only shows a launch line, so the
// host reads each subagent's own transcript (native agent_subagents.go) and
// the session reply carries `subagents`. Running ones show by default with
// their latest tool, call count and run time; recently finished ones fold
// under 已完成.
import { useLingui } from '@lingui/react/macro'
import { useEffect, useState } from 'react'

import { Led } from '#/components/deck/led'

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
          <span className="truncate text-[14px] font-medium">{title}</span>
          <span className="shrink-0 text-[11.5px] text-brand-label tabular-nums">
            {ran}
          </span>
        </span>
        <span className="truncate font-mono text-[11.5px] text-brand-muted">
          {agent.state === 'stale'
            ? t`No activity for a while`
            : (agent.last_tool ??
              (agent.state === 'done' ? t`Finished` : t`Starting…`))}
        </span>
        <span className="text-[11px] text-brand-label">
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
  const [showDone, setShowDone] = useState(false)
  const list = agents ?? []
  const running = list.filter((agent) => agent.state === 'running')
  const rest = list.filter((agent) => agent.state !== 'running')
  const now = useNow(running.length > 0)
  if (list.length === 0) return null
  const runningCount = running.length
  const doneCount = rest.length
  return (
    <section
      data-testid="session-subagents"
      className="overflow-hidden rounded-[14px] bg-brand-surface"
    >
      {running.length ? (
        <>
          <p className="px-3 pt-2 text-[12px] font-medium text-brand-muted">
            {t`${runningCount} subagents running`}
          </p>
          <ul className="divide-y divide-brand-edge">
            {running.map((agent) => (
              <Row key={agent.id} agent={agent} now={now} />
            ))}
          </ul>
        </>
      ) : null}
      {rest.length ? (
        <>
          <button
            type="button"
            onClick={() => setShowDone(!showDone)}
            className="w-full px-3 py-2 text-left text-[12px] text-brand-label"
          >
            {showDone ? t`Hide finished subagents` : t`Finished (${doneCount})`}
          </button>
          {showDone ? (
            <ul className="divide-y divide-brand-edge border-t border-brand-edge">
              {rest.map((agent) => (
                <Row key={agent.id} agent={agent} now={now} />
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  )
}
