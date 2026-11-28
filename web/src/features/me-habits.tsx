import { useLingui } from '@lingui/react/macro'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { lazy, Suspense, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'

import { Segmented } from '#/components/deck/segmented'
import { Button } from '#/components/ui/button'
import { SectionHeading } from '#/components/ui/section-heading'
import { useLocale } from '#/lib/locale-context'
import { hostRead, hostWrite } from '#/lib/runtime-client'
import { useConsoleMode } from './console-mode'
import { useDeviceState } from './device-state'

const MarkdownFileBody = lazy(() =>
  import('./host-file-body').then((module) => ({
    default: module.MarkdownFileBody,
  })),
)

const periodSchema = z.enum(['this', 'last', '14d'])
type Period = z.infer<typeof periodSchema>
const reportSchema = z.union([
  z.object({
    available: z.literal(true),
    present: z.literal(false),
    period: periodSchema,
  }),
  z.object({
    available: z.literal(true),
    present: z.literal(true),
    period: periodSchema,
    generated_at: z.string(),
    window: z.object({ start: z.string(), end: z.string() }),
    work_focus: z.object({
      ok: z.boolean(),
      commits: z.number(),
      web_related: z.number(),
      areas: z.record(z.string(), z.number()),
      daily: z.array(
        z.object({
          day: z.string(),
          commits: z.number(),
          web_related: z.number(),
        }),
      ),
    }),
    max_running: z.number(),
    verify: z.object({
      cdp_calls: z.number().optional(),
      iterate_after_cdp: z.number().optional(),
    }),
    active_minutes_p50: z.number().nullable(),
    user_turns: z.number(),
    hotkeys: z.object({
      total_hotkey_presses: z.number(),
      daily: z.array(z.object({ day: z.string(), total_hotkeys: z.number() })),
    }),
    wakatime: z.object({
      ok: z.boolean(),
      totals: z.object({ text: z.string() }),
    }),
    markdown: z.string().optional(),
  }),
])
type HabitReport = Extract<z.infer<typeof reportSchema>, { present: true }>

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 border-b border-brand-edge py-3">
      <div className="text-caption text-brand-muted">{label}</div>
      <div
        className="mt-1 truncate text-title font-semibold tabular-nums text-brand-text"
        title={value}
      >
        {value}
      </div>
    </div>
  )
}

function HabitOverview({ report }: { report: HabitReport }) {
  const { t } = useLingui()
  const { locale } = useLocale()
  const number = new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en-US')
  const focus = report.work_focus
  const share =
    focus.commits > 0
      ? Math.round((focus.web_related / focus.commits) * 100)
      : 0
  const labels: Record<string, string> = {
    web: t({ message: 'Web UI' }),
    relay: t({ message: 'WSL relay' }),
    runtime: t({ message: 'Windows Runtime' }),
    terminal: t({ message: 'Terminal config' }),
    automation: t({ message: 'Automation' }),
    docs: t({ message: 'Documentation' }),
    other: t({ message: 'Other' }),
  }
  const areas = Object.entries(focus.areas).sort((a, b) => b[1] - a[1])
  const maxDay = Math.max(1, ...focus.daily.map((row) => row.commits))

  return (
    <div className="grid min-w-0 gap-7" data-testid="habit-overview">
      <section className="grid grid-cols-2 gap-x-5 md:grid-cols-4">
        <Metric
          label={t({ message: 'Web / host work' })}
          value={focus.commits ? share + '%' : '—'}
        />
        <Metric
          label={t({ message: 'Agent concurrency peak' })}
          value={number.format(report.max_running)}
        />
        <Metric
          label={t({ message: 'CDP verifications' })}
          value={number.format(report.verify.cdp_calls ?? 0)}
        />
        <Metric
          label={t({ message: 'Iterated after verification' })}
          value={number.format(report.verify.iterate_after_cdp ?? 0)}
        />
      </section>

      <section className="grid gap-3">
        <SectionHeading>{t({ message: 'Work focus' })}</SectionHeading>
        <p className="text-caption text-brand-muted">
          {t({
            message:
              'Non-merge commits in this repository. A commit may touch several areas.',
          })}
        </p>
        {areas.length ? (
          <div className="grid gap-2">
            {areas.map(([area, count]) => (
              <div
                key={area}
                className="grid min-w-0 grid-cols-[minmax(6rem,9rem)_minmax(0,1fr)_3rem] items-center gap-2 text-caption"
              >
                <span className="truncate text-brand-muted">
                  {labels[area] ?? area}
                </span>
                <div className="h-2 overflow-hidden rounded-sm bg-brand-edge">
                  <div
                    className="h-full bg-brand-running"
                    style={{
                      width:
                        Math.max(
                          2,
                          (count / Math.max(1, focus.commits)) * 100,
                        ) + '%',
                    }}
                  />
                </div>
                <span className="text-right tabular-nums text-brand-text">
                  {number.format(count)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-caption text-brand-muted">
            {t({ message: 'No commits in this period.' })}
          </p>
        )}
      </section>

      <section className="grid gap-3">
        <SectionHeading>{t({ message: 'Daily activity' })}</SectionHeading>
        <div className="grid gap-2">
          {focus.daily.map((day) => (
            <div
              key={day.day}
              className="grid grid-cols-[5.5rem_minmax(0,1fr)_3rem] items-center gap-2 text-caption"
            >
              <time
                className="tabular-nums text-brand-muted"
                dateTime={day.day}
              >
                {day.day.slice(5)}
              </time>
              <div
                className="flex h-2 overflow-hidden rounded-sm bg-brand-edge"
                style={{ width: (day.commits / maxDay) * 100 + '%' }}
              >
                <div
                  className="h-full bg-brand-running"
                  style={{
                    width:
                      (day.web_related / Math.max(1, day.commits)) * 100 + '%',
                  }}
                />
              </div>
              <span className="text-right tabular-nums text-brand-text">
                {number.format(day.commits)}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-3">
        <SectionHeading>{t({ message: 'Development habits' })}</SectionHeading>
        <div className="grid grid-cols-2 gap-x-5 md:grid-cols-4">
          <Metric
            label={t({ message: 'Agent turns' })}
            value={number.format(report.user_turns)}
          />
          <Metric
            label={t({ message: 'Active session median' })}
            value={
              report.active_minutes_p50 === null
                ? '—'
                : number.format(report.active_minutes_p50) + ' min'
            }
          />
          <Metric
            label={t({ message: 'Terminal hotkeys observed' })}
            value={number.format(report.hotkeys.total_hotkey_presses)}
          />
          <Metric
            label={t({ message: 'WakaTime' })}
            value={report.wakatime.ok ? report.wakatime.totals.text : '—'}
          />
        </div>
      </section>
    </div>
  )
}

export function HabitsPage() {
  const { t } = useLingui()
  const client = useQueryClient()
  const [period, setPeriod] = useState<Period>('this')
  const [view, setView] = useState<'overview' | 'report'>('overview')
  const [refreshFrom, setRefreshFrom] = useState<{
    period: Period
    at: string
  } | null>(null)
  const mode = useConsoleMode()
  const device = useDeviceState()
  const authorized = mode === 'local' || device.state === 'approved'
  const refreshing = refreshFrom?.period === period

  const summary = useQuery({
    queryKey: ['habit-report', period],
    queryFn: async () =>
      reportSchema.parse(await hostRead('habit.weekly', { period })),
    enabled: authorized,
    staleTime: 30_000,
    refetchInterval: refreshing ? 3_000 : 60_000,
    retry: false,
  })
  const full = useQuery({
    queryKey: ['habit-report', period, 'markdown'],
    queryFn: async () =>
      reportSchema.parse(
        await hostRead('habit.weekly', { period, include_markdown: true }),
      ),
    enabled: authorized && view === 'report',
    staleTime: 60_000,
    retry: false,
  })

  useEffect(() => {
    if (!refreshFrom || refreshFrom.period !== period) return
    if (summary.data?.present && summary.data.generated_at !== refreshFrom.at) {
      setRefreshFrom(null)
      void client.invalidateQueries({
        queryKey: ['habit-report', period, 'markdown'],
      })
    }
  }, [client, period, refreshFrom, summary.data])

  useEffect(() => {
    if (!refreshFrom) return
    const timeout = window.setTimeout(() => {
      setRefreshFrom(null)
      toast(t({ message: 'Report refresh is taking longer than expected.' }))
    }, 180_000)
    return () => window.clearTimeout(timeout)
  }, [refreshFrom, t])

  const refresh = async () => {
    if (period === 'last' && summary.data?.present) return
    try {
      await hostWrite('habit.refresh', {})
      setRefreshFrom({
        period,
        at: summary.data?.present ? summary.data.generated_at : '',
      })
      toast(t({ message: 'Updating development habits' }))
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : t({ message: 'Refresh failed' }),
      )
    }
  }
  const data = summary.data
  const generated = data?.present
    ? new Date(data.generated_at).toLocaleString()
    : ''
  const stale =
    data?.present &&
    period !== 'last' &&
    Date.now() - Date.parse(data.generated_at) > 24 * 60 * 60 * 1000

  return (
    <div className="grid min-w-0 gap-5 pb-6" data-testid="habit-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label={t({ message: 'Report period' })}
          value={period}
          onChange={setPeriod}
          className="w-full max-w-md"
          options={[
            { value: 'this', label: t({ message: 'This week' }) },
            { value: 'last', label: t({ message: 'Last week' }) },
            { value: '14d', label: t({ message: 'Last 14 days' }) },
          ]}
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => void refresh()}
          disabled={
            !authorized || refreshing || (period === 'last' && data?.present)
          }
          title={t({ message: 'Generate a fresh report' })}
          className="min-h-10 px-3"
        >
          <RefreshCw
            size={16}
            aria-hidden
            className={refreshing ? 'animate-spin' : ''}
          />
          {t({ message: 'Refresh' })}
        </Button>
      </div>

      {!authorized ? (
        <p className="text-body text-brand-muted">
          {t({ message: 'Approve this device to view development habits.' })}
        </p>
      ) : summary.isPending ? (
        <p role="status" className="text-body text-brand-muted">
          {t({ message: 'Loading development habits…' })}
        </p>
      ) : summary.isError ? (
        <p role="alert" className="text-body text-brand-waiting">
          {t({ message: 'Development habits are unavailable.' })}
        </p>
      ) : !data?.present ? (
        <p className="text-body text-brand-muted">
          {t({ message: 'No report has been generated for this period.' })}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-brand-edge pb-2 text-caption text-brand-muted">
            <span>
              {data.window.start} – {data.window.end}
            </span>
            <span>
              {stale ? t({ message: 'Needs refresh' }) + ' · ' : ''}
              {t({ message: 'Updated' })} {generated}
            </span>
          </div>
          <Segmented
            label={t({ message: 'Report view' })}
            value={view}
            onChange={setView}
            className="w-full max-w-xs"
            options={[
              { value: 'overview', label: t({ message: 'Overview' }) },
              { value: 'report', label: t({ message: 'Full report' }) },
            ]}
          />
          {view === 'overview' ? (
            <HabitOverview report={data} />
          ) : full.isPending ? (
            <p role="status">{t({ message: 'Loading report…' })}</p>
          ) : full.data?.present && full.data.markdown ? (
            <Suspense
              fallback={
                <p role="status">{t({ message: 'Loading report…' })}</p>
              }
            >
              <MarkdownFileBody content={full.data.markdown} />
            </Suspense>
          ) : (
            <p role="alert">{t({ message: 'Full report is unavailable.' })}</p>
          )}
        </>
      )}
    </div>
  )
}
