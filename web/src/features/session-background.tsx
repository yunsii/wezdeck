// The session's background tasks (Bash run_in_background, Monitor), under the
// header's meter row: what each one is — the call's description or command,
// how long it has run, its newest output line — instead of a bare task id.
// A row opens to the full command and the last output lines, and jumps to
// the call that started it in the thread (native bg_detail.go).
import { useLingui } from '@lingui/react/macro'
import { useEffect, useState } from 'react'

import { Led } from '#/components/deck/led'
import { Button } from '#/components/ui/button'
import { Disclosure } from '#/components/ui/disclosure'

/** a background task as the session reply carries it */
export type BgTask = {
  id: string
  type: string
  summary: string
  /** from the call that started it (native bg_detail.go) */
  tool?: string
  label?: string
  command?: string
  started?: string
  /** the call's message index in the transcript */
  at?: number
  /** the output's last lines */
  tail?: Array<string>
}

function useNow() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return now
}

function elapsed(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m${s % 60}s` : `${Math.floor(m / 60)}h${m % 60}m`
}

/** the call in the thread, if it is laid out (an older page may not be) */
const callRow = (at?: number) =>
  at === undefined
    ? null
    : document.querySelector<HTMLElement>(`[data-msg="${at}"]`)

function TaskRow({ task, now }: { task: BgTask; now: number }) {
  const { t } = useLingui()
  const started = task.started ? Date.parse(task.started) : NaN
  const ran = Number.isNaN(started) ? '' : elapsed(now - started)
  const label = task.label || task.command || task.summary || task.id
  const last = task.tail?.at(-1)
  return (
    <li data-bg-task={task.id}>
      <Disclosure
        chevron={false}
        className="min-w-0"
        triggerClassName="grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2 gap-y-0.5 py-1 text-left"
        title={
          <>
            <span className="pt-1">
              <Led tone="running" size={9} className="led-running" />
            </span>
            <span className="truncate text-caption text-brand-text">
              {task.tool ? (
                <span className="mr-1.5 font-mono text-meta text-brand-label">
                  {task.tool}
                </span>
              ) : null}
              {label}
            </span>
            <span data-live className="text-meta text-brand-label tabular-nums">
              {ran}
            </span>
            {last ? (
              <span className="col-start-2 col-end-4 truncate font-mono text-meta text-brand-muted">
                {last}
              </span>
            ) : null}
          </>
        }
      >
        <div className="grid min-w-0 gap-1.5 pb-1.5 pl-5">
          {task.command && task.command !== label ? (
            <pre className="overflow-x-auto rounded-lg bg-brand-deck px-2 py-1.5 font-mono text-meta whitespace-pre-wrap text-brand-text">
              {task.command}
            </pre>
          ) : null}
          {task.tail?.length ? (
            <pre
              aria-label={t`Latest output`}
              className="overflow-x-auto font-mono text-meta whitespace-pre-wrap text-brand-muted"
            >
              {task.tail.join('\n')}
            </pre>
          ) : (
            <p className="text-meta text-brand-label">{t`No output yet`}</p>
          )}
          <span className="flex flex-wrap items-center gap-2 text-meta text-brand-label">
            <span className="font-mono">{task.id}</span>
            {task.at !== undefined ? (
              <Button
                variant="plain"
                type="button"
                data-testid="bg-jump"
                onClick={() =>
                  callRow(task.at)?.scrollIntoView({
                    block: 'center',
                    behavior: 'smooth',
                  })
                }
                className="rounded-full bg-brand-surface px-2 py-0.5 text-brand-text"
              >
                {t`Show the call`}
              </Button>
            ) : null}
          </span>
        </div>
      </Disclosure>
    </li>
  )
}

export function BackgroundTasks({ tasks }: { tasks: Array<BgTask> }) {
  const { t } = useLingui()
  const now = useNow()
  return (
    <ul
      aria-label={t`Background tasks`}
      data-testid="background-tasks"
      className="grid gap-0.5 rounded-xl bg-brand-surface px-3 py-1.5"
    >
      {tasks.map((task) => (
        <TaskRow key={task.id} task={task} now={now} />
      ))}
    </ul>
  )
}
