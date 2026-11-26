import { Popover as PopoverPrimitive } from '@base-ui/react/popover'
import { useLingui } from '@lingui/react/macro'

import { PopoverContent } from '#/components/ui/popover'
import { cn } from '#/lib/utils'
import type { AccountLimits, Usage } from './console-sessions'

export const NEAR_FULL = 75

export type UsageMetric = {
  id: 'context' | 'five-hour' | 'seven-day'
  percent: number
  resetsAt?: number
}

export function usageMetrics(
  usage?: Usage,
  account?: AccountLimits,
  now = Date.now(),
): Array<UsageMetric> {
  const metrics: Array<UsageMetric> = []
  if (usage && usage.context_limit > 0 && usage.context > 0) {
    metrics.push({
      id: 'context',
      percent: (usage.context / usage.context_limit) * 100,
    })
  }
  for (const [id, window] of [
    ['five-hour', account?.five_hour],
    ['seven-day', account?.seven_day],
  ] as const) {
    if (window && (!window.resets_at || window.resets_at * 1000 > now)) {
      metrics.push({
        id,
        percent: window.used_percentage,
        resetsAt: window.resets_at,
      })
    }
  }
  return metrics
}

export function useUsageLabel() {
  const { t } = useLingui()
  return (id: UsageMetric['id']) =>
    id === 'context' ? t`Context` : id === 'five-hour' ? t`5 h` : t`7 d`
}

export function usagePercent(percent: number) {
  return Math.max(0, Math.min(100, Math.round(percent)))
}

export function UsageTag({
  metric,
  usage,
}: {
  metric: UsageMetric
  usage?: Usage
}) {
  const { t, i18n } = useLingui()
  const label = useUsageLabel()(metric.id)
  const percent = usagePercent(metric.percent)
  const usedTokens = i18n.number(usage?.context ?? 0)
  const limitTokens = i18n.number(usage?.context_limit ?? 0)
  const reset = metric.resetsAt
    ? i18n.date(new Date(metric.resetsAt * 1000), {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : undefined
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger
        data-tag-id={metric.id}
        aria-label={t`${label} ${percent}% used`}
        data-tone={metric.percent >= NEAR_FULL ? 'waiting' : 'neutral'}
        className={cn(
          'session-tag cursor-pointer text-meta outline-none focus-visible:ring-2 focus-visible:ring-brand-running',
          metric.percent >= 90 && '[--tone:var(--brand-error)]!',
        )}
      >
        {label} <span className="tabular-nums">{percent}%</span>
      </PopoverPrimitive.Trigger>
      <PopoverContent
        side="top"
        sideOffset={6}
        className="grid gap-1 px-2.5 py-2 text-meta"
      >
        <strong>{t`${label} ${percent}% used`}</strong>
        {metric.id === 'context' ? (
          <span>{t`${usedTokens} / ${limitTokens} tokens`}</span>
        ) : null}
        {reset ? <span>{t`Resets ${reset}`}</span> : null}
      </PopoverContent>
    </PopoverPrimitive.Root>
  )
}
