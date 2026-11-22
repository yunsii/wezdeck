// Top of a session page: back, status, context / spend, background tasks.
import { useLingui } from '@lingui/react/macro'
import { ChevronLeft } from 'lucide-react'

import { Led } from '#/components/deck/led'
import { cn } from '#/lib/utils'
import { sessionTone, useStatusText } from './console-sessions'
import type { Detail, Usage } from './console-sessions'

const tokens = (n: number) =>
  n >= 10_000 ? `${(n / 10_000).toFixed(n >= 100_000 ? 0 : 1)} 万` : String(n)

/** Context used vs the model's limit, plus what the session has spent. */
function SessionUsage({ usage }: { usage: Usage }) {
  const { t } = useLingui()
  const share = usage.context_limit
    ? Math.min(100, Math.round((usage.context / usage.context_limit) * 100))
    : 0
  const hit =
    usage.input + usage.cache_read
      ? Math.round((usage.cache_read / (usage.input + usage.cache_read)) * 100)
      : 0
  const used = tokens(usage.context)
  const limit = tokens(usage.context_limit)
  const output = tokens(usage.output)
  if (!usage.context_limit || !usage.context)
    return usage.model ? (
      <p
        data-testid="session-usage"
        className="rounded-[12px] bg-brand-surface px-3 py-2 text-[11px] text-brand-label"
      >
        {usage.model}
      </p>
    ) : null
  const tone =
    share >= 85
      ? 'bg-brand-error'
      : share >= 60
        ? 'bg-brand-waiting'
        : 'bg-brand-running'
  return (
    <div
      data-testid="session-usage"
      className="grid gap-1.5 rounded-[12px] bg-brand-surface px-3 py-2"
    >
      <div className="flex items-baseline justify-between gap-2 text-[12px]">
        <span className="text-brand-muted">
          {t`Context ${used} / ${limit}`}
        </span>
        <span className="font-medium">{share}%</span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-brand-deck"
        aria-hidden
      >
        <div
          className={cn('h-full rounded-full', tone)}
          style={{ width: `${share}%` }}
        />
      </div>
      <div className="flex flex-wrap gap-x-3 text-[11px] text-brand-label">
        {usage.model ? <span>{usage.model}</span> : null}
        <span>{t`output ${output}`}</span>
        <span>{t`cache hit ${hit}%`}</span>
      </div>
    </div>
  )
}

export function SessionHeader({
  data,
  onBack,
}: {
  data: Detail | undefined
  onBack: () => void
}) {
  const { t } = useLingui()
  const statusText = useStatusText()
  const tone = sessionTone(data?.status ?? '', data?.waiting_kind)
  return (
    <div className="grid gap-2">
      <button
        type="button"
        onClick={onBack}
        className="-ml-2 inline-flex min-h-11 w-fit items-center gap-1 px-2 text-[15px] text-brand-muted"
      >
        <ChevronLeft size={20} aria-hidden />
        {t({ message: 'Sessions', context: 'nav' })}
      </button>
      <p className="inline-flex items-center gap-2 text-sm text-brand-muted">
        <Led tone={tone} size={11} />
        {data
          ? statusText(
              data.status,
              data.waiting_kind,
              data.running_kind,
              data.background?.length ?? 0,
            )
          : t`Loading…`}
      </p>
      {data?.usage?.turns ? <SessionUsage usage={data.usage} /> : null}
      {data?.background?.length ? (
        <ul
          aria-label={t`Background tasks`}
          className="grid gap-1 rounded-[12px] bg-brand-surface px-3 py-2"
        >
          {data.background.map((task) => (
            <li
              key={task.id}
              className="flex items-center gap-2 truncate font-mono text-[12px] text-brand-muted"
            >
              <Led tone="running" size={9} />
              {task.summary || task.id}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
