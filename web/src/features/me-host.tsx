// 我的 › 本机 (this computer, local Runtime only): what the old 总览 page
// showed — the Runtime, input method, WSL bridge — as Field rows to read and
// copy, the capability list folded. Diagnostics stays its own page.
import { useLingui } from '@lingui/react/macro'

import { Led } from '#/components/deck/led'
import type { LedTone } from '#/components/deck/led'
import { Button } from '#/components/ui/button'
import { Disclosure } from '#/components/ui/disclosure'
import { SectionHeading } from '#/components/ui/section-heading'
import { Field, FieldList } from '#/components/ui/field'
import { useConsoleMode } from './console-mode'
import { HostQuickControls } from './host-quick-controls'
import { runtimeQuery, useRuntimeData } from './console-data'
import {
  ImeDetail,
  formatDuration,
  formatNumber,
  formatTime,
} from './console-shared'

type Check = { name: string; tone: LedTone }

/** the five checks, for the 本机 row's summary and the page's status line */
export function useHostChecks(): Array<Check> {
  const { t } = useLingui()
  const runtime = useRuntimeData()
  const { data, connected, eventReady, loading } = runtime
  const wsl = runtimeQuery(runtime.wsl)
  const wslAdvertised =
    data?.health.capabilities.includes('wsl.status') ?? false
  const tone = (ok: boolean, bad: LedTone = 'waiting'): LedTone =>
    loading ? 'running' : ok ? 'done' : bad
  return [
    { name: t`Runtime API`, tone: tone(connected, 'error') },
    { name: t`Event stream`, tone: tone(eventReady) },
    { name: t`Rime collector`, tone: tone(Boolean(data?.rime)) },
    { name: t`Host signals`, tone: tone(Boolean(data?.ime)) },
    {
      name: t`WSL bridge`,
      tone:
        !wslAdvertised && !loading
          ? 'waiting'
          : wsl.isPending
            ? 'running'
            : tone(Boolean(wsl.data?.available), 'error'),
    },
  ]
}

/** 本机 row value: 就绪, or how many checks are off */
export function useHostSummary() {
  const { t } = useLingui()
  const checks = useHostChecks()
  const off = checks.filter(
    (check) => check.tone === 'error' || check.tone === 'waiting',
  ).length
  if (checks.some((check) => check.tone === 'running')) return t`Checking…`
  return off ? t`${off} need attention` : t`Ready`
}

export function HostPage() {
  const mode = useConsoleMode()
  return (
    <div className="grid gap-4">
      <HostQuickControls />
      {mode === 'local' ? <LocalHostDetails /> : null}
    </div>
  )
}

function LocalHostDetails() {
  const { t } = useLingui()
  const runtime = useRuntimeData()
  const { data, error, loading, refreshAll } = runtime
  const wsl = runtimeQuery(runtime.wsl)
  const wslAdvertised =
    data?.health.capabilities.includes('wsl.status') ?? false
  const checks = useHostChecks()
  const capabilityCount = data?.health.capabilities.length ?? 0
  const none = t`Unavailable`
  const group = (title: string, rows: Array<[string, string]>) => (
    <section className="grid gap-1">
      <SectionHeading as="h2" className="bg-brand-key">
        {title}
      </SectionHeading>
      <FieldList>
        {rows.map(([label, value]) => (
          <Field key={label} label={label} value={value} mono />
        ))}
      </FieldList>
    </section>
  )
  return (
    <div className="grid gap-4">
      {error && !loading ? (
        <div className="flex items-center justify-between gap-3 rounded-xl bg-brand-waiting/10 px-3 py-2 text-body">
          <span>{error}</span>
          <Button size="sm" variant="warning" onClick={() => void refreshAll()}>
            {t`Retry`}
          </Button>
        </div>
      ) : null}
      <ul className="flex flex-wrap gap-x-4 gap-y-1.5 px-1 text-caption text-brand-muted">
        {checks.map((check) => (
          <li key={check.name} className="inline-flex items-center gap-1.5">
            <Led tone={check.tone} size={9} />
            {check.name}
          </li>
        ))}
      </ul>
      {group(t`Runtime`, [
        [t`Instance`, data?.health.instance_id ?? none],
        [t`Endpoint`, runtime.probe.data?.baseUrl ?? 'http://127.0.0.1:35791'],
        [t`Uptime`, formatDuration(data?.health.uptime_ms)],
        [t`Last sample`, formatTime(data?.health.observed_at)],
      ])}
      <section className="grid gap-1">
        {group(t`Input method`, [
          [t`Input method`, data?.ime?.mode ?? none],
          [
            t`Today`,
            formatNumber(data?.rime?.today_chars ?? data?.rime?.chars),
          ],
          [
            t`Today events`,
            formatNumber(data?.rime?.today_events ?? data?.rime?.events),
          ],
          [t`All time`, formatNumber(data?.rime?.chars)],
          [t`Latest`, formatTime(data?.rime?.last_ts)],
        ])}
        <p className="px-1 text-meta text-brand-label">
          <ImeDetail ime={data?.ime} />
        </p>
      </section>
      {group(t`WSL bridge`, [
        [
          t`Status`,
          !wslAdvertised
            ? t`Not on this Runtime`
            : wsl.data?.available
              ? t`Ready`
              : none,
        ],
        [t`Socket`, wsl.data?.socket || none],
        [t`Process`, wsl.data?.pid ? String(wsl.data.pid) : none],
      ])}
      <Disclosure
        className="overflow-hidden rounded-xl bg-brand-surface"
        triggerClassName="min-h-11 px-3 text-body font-medium"
        title={t`Capabilities (${capabilityCount})`}
      >
        <p className="px-3 pb-3 font-mono text-meta leading-relaxed break-words text-brand-muted">
          {data?.health.capabilities.join('  ') || none}
        </p>
      </Disclosure>
    </div>
  )
}
