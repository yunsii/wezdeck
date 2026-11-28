import { useLingui } from '@lingui/react/macro'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Play, Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'

import { Button } from '#/components/ui/button'
import { Checkbox } from '#/components/ui/checkbox'
import { Input } from '#/components/ui/input'
import { SectionHeading } from '#/components/ui/section-heading'
import { useLocale } from '#/lib/locale-context'
import { hostRead, hostWrite } from '#/lib/runtime-client'
import { useConsoleMode } from './console-mode'
import { useDeviceState } from './device-state'

const scheduleSchema = z.object({
  installed: z.boolean(),
  enabled: z.boolean(),
  times: z.array(z.string()).length(3),
  active: z.boolean().optional(),
  next_run: z.string().optional(),
  last_trigger: z.string().optional(),
  last_result: z.string().optional(),
})
type Schedule = z.infer<typeof scheduleSchema>

const key = ['habit-schedule'] as const

export function SchedulePage() {
  const { t } = useLingui()
  const { locale } = useLocale()
  const client = useQueryClient()
  const mode = useConsoleMode()
  const device = useDeviceState()
  const authorized = mode === 'local' || device.state === 'approved'
  const [times, setTimes] = useState<Array<string>>(['09:00', '12:30', '18:30'])
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)

  const status = useQuery({
    queryKey: key,
    queryFn: async () =>
      scheduleSchema.parse(await hostRead('habit.schedule.status')),
    enabled: authorized,
    staleTime: 10_000,
    refetchInterval: 30_000,
    retry: false,
  })
  useEffect(() => {
    if (status.data && !editing) setTimes(status.data.times)
  }, [editing, status.data])

  const update = async (payload: Record<string, unknown>, message: string) => {
    setBusy(true)
    try {
      const next: Schedule = scheduleSchema.parse(
        await hostWrite('habit.schedule.update', payload),
      )
      client.setQueryData(key, next)
      setTimes(next.times)
      setEditing(false)
      toast(message)
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : t({ message: 'Schedule change failed' }),
      )
    } finally {
      setBusy(false)
    }
  }

  if (!authorized)
    return (
      <p className="text-body text-brand-muted">
        {t({ message: 'Approve this device to manage scheduled reports.' })}
      </p>
    )
  if (status.isPending)
    return (
      <p role="status" className="text-body text-brand-muted">
        {t({ message: 'Loading scheduled tasks…' })}
      </p>
    )
  if (status.isError)
    return (
      <p role="alert" className="text-body text-brand-waiting">
        {t({ message: 'Scheduled tasks are unavailable.' })}
      </p>
    )

  const schedule = status.data
  const changed = times.join(',') !== schedule.times.join(',')
  const labels = [
    t({ message: 'Morning' }),
    t({ message: 'Midday' }),
    t({ message: 'Evening' }),
  ]
  const formatTime = (value?: string) => {
    if (!value) return '—'
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime())
      ? value
      : parsed.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone: 'Asia/Singapore',
        })
  }
  const resultLabel =
    schedule.last_result === 'success'
      ? t({ message: 'Succeeded' })
      : schedule.last_result === 'failed'
        ? t({ message: 'Failed' })
        : schedule.last_result || '—'
  return (
    <div className="grid min-w-0 gap-6 pb-6" data-testid="habit-schedule">
      <section className="grid gap-3">
        <SectionHeading>
          {t({ message: 'Development habit report' })}
        </SectionHeading>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-brand-edge py-3">
          <div>
            <div className="text-body font-medium text-brand-text">
              {t({ message: 'Automatic refresh' })}
            </div>
            <div className="text-caption text-brand-muted">
              {t({ message: 'Singapore time' })}
            </div>
          </div>
          <label className="inline-flex min-h-10 items-center gap-2 text-caption text-brand-text">
            <Checkbox
              checked={schedule.enabled}
              disabled={!schedule.installed || busy || editing}
              onCheckedChange={(checked) =>
                void update(
                  { op: 'set_enabled', enabled: checked },
                  checked
                    ? t({ message: 'Schedule enabled' })
                    : t({ message: 'Schedule paused' }),
                )
              }
              className="h-5 w-5 accent-brand-running"
            />
            {schedule.enabled ? t({ message: 'On' }) : t({ message: 'Off' })}
          </label>
        </div>
        {!schedule.installed ? (
          <p className="text-caption text-brand-muted">
            {t({
              message:
                'The habit snapshot timer is not installed on this host.',
            })}
          </p>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {times.map((value, index) => (
                <label
                  key={labels[index]}
                  className="grid gap-1 text-caption text-brand-muted"
                >
                  {labels[index]}
                  <Input
                    type="time"
                    variant="field"
                    value={value}
                    disabled={busy}
                    onChange={(event) => {
                      const next = [...times]
                      next[index] = event.target.value
                      setTimes(next)
                      setEditing(true)
                    }}
                    className="min-h-10 rounded-lg border border-brand-edge bg-brand-surface px-3 text-body text-brand-text outline-none focus-visible:ring-2 focus-visible:ring-brand-running"
                  />
                </label>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={!changed || busy}
                onClick={() =>
                  void update(
                    { op: 'set_times', times },
                    t({ message: 'Refresh times saved' }),
                  )
                }
                className="min-h-10 px-3"
              >
                <Save size={16} aria-hidden />
                {t({ message: 'Save times' })}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void update(
                    { op: 'run_now' },
                    t({ message: 'Report generation started' }),
                  )
                }
                className="min-h-10 px-3"
              >
                <Play size={16} aria-hidden />
                {t({ message: 'Generate report now' })}
              </Button>
            </div>
          </>
        )}
      </section>
      {schedule.installed ? (
        <section className="grid gap-2 text-caption text-brand-muted">
          <SectionHeading>{t({ message: 'Latest run' })}</SectionHeading>
          <p>
            {t({ message: 'Next scheduled run' })}{' '}
            <span className="text-brand-text">
              {formatTime(schedule.next_run)}
            </span>
          </p>
          <p>
            {t({ message: 'Last trigger' })}{' '}
            <span className="text-brand-text">
              {formatTime(schedule.last_trigger)}
            </span>
          </p>
          <p>
            {t({ message: 'Last result' })}{' '}
            <span className="text-brand-text">{resultLabel}</span>
          </p>
        </section>
      ) : null}
    </div>
  )
}
