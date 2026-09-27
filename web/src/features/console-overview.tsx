import { useLingui } from '@lingui/react/macro'

import { Button } from '#/components/ui/button'
import { runtimeQuery, useRuntimeData } from './console-data'
import {
  ImeDetail,
  formatDuration,
  formatNumber,
  formatTime,
} from './console-shared'
import type { CheckStatus } from './console-shared'

export function ConsoleOverviewPage() {
  const { t } = useLingui()
  const runtimeData = useRuntimeData()
  const { data, connected, eventReady, loading, error, refreshAll } =
    runtimeData
  const wsl = runtimeQuery(runtimeData.wsl)
  const wslAdvertised =
    data?.health.capabilities.includes('wsl.status') ?? false
  const endpoint = useRuntimeEndpoint(runtimeData.probe)
  const statuses: Array<{ name: string; status: CheckStatus }> = [
    {
      name: t`Runtime API`,
      status: loading ? 'loading' : connected ? 'ready' : 'offline',
    },
    {
      name: t`Event stream`,
      status: loading ? 'loading' : eventReady ? 'ready' : 'warning',
    },
    {
      name: t`Rime collector`,
      status: loading ? 'loading' : data?.rime ? 'ready' : 'warning',
    },
    {
      name: t`Host signals`,
      status: loading ? 'loading' : data?.ime ? 'ready' : 'warning',
    },
    {
      name: t`WSL bridge`,
      status: loading
        ? 'loading'
        : !wslAdvertised
          ? 'warning'
          : wsl.isPending
            ? 'loading'
            : wsl.data?.available
              ? 'ready'
              : 'offline',
    },
  ]
  const runtime: Array<[string, string]> = [
    [t`Instance`, data?.health.instance_id ?? t`Unavailable`],
    [t`Endpoint`, endpoint],
    [t`Uptime`, formatDuration(data?.health.uptime_ms)],
    [t`Last sample`, formatTime(data?.health.observed_at)],
  ]
  const secondary: Array<{ name: string; facts: Array<[string, string]> }> = [
    {
      name: t`Rime collector`,
      facts: [
        [t`Today`, formatNumber(data?.rime?.today_chars ?? data?.rime?.chars)],
        [
          t`Today events`,
          formatNumber(data?.rime?.today_events ?? data?.rime?.events),
        ],
        [t`All time`, formatNumber(data?.rime?.chars)],
        [t`Latest`, formatTime(data?.rime?.last_ts)],
      ],
    },
    {
      name: t`Host signals`,
      facts: [[t`Input method`, data?.ime?.mode ?? t`Unavailable`]],
    },
    {
      name: t`WSL bridge`,
      facts: [
        [
          t`Status`,
          !wslAdvertised
            ? t`Not on this Runtime`
            : wsl.data?.available
              ? t`Ready`
              : t`Unavailable`,
        ],
        [t`Socket`, wsl.data?.socket || t`Unavailable`],
        [t`Process`, wsl.data?.pid ? String(wsl.data.pid) : t`Unavailable`],
      ],
    },
  ]
  const dot = {
    loading: 'bg-brand-waiting',
    ready: 'bg-brand-done',
    warning: 'bg-brand-waiting',
    offline: 'bg-brand-error',
  }

  return (
    <div className="grid content-start gap-4">
      {error && !loading ? (
        <div className="flex items-center justify-between gap-3 border border-brand-waiting bg-brand-waiting/10 px-3 py-2 text-sm text-brand-waiting">
          <span>{error}</span>
          <Button size="sm" variant="warning" onClick={() => void refreshAll()}>
            {t`Retry`}
          </Button>
        </div>
      ) : null}
      <ul className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-brand-muted">
        {statuses.map((item) => (
          <li key={item.name} className="inline-flex items-center gap-1.5">
            <span
              className={`size-1.5 rounded-full ${dot[item.status]} ${item.status === 'loading' ? 'motion-safe:animate-pulse' : ''}`}
            />
            {item.name}
          </li>
        ))}
      </ul>
      <section>
        <h2 className="text-lg font-semibold text-brand-text">{t`Runtime`}</h2>
        <dl className="mt-3 grid gap-x-8 gap-y-3 sm:grid-cols-2">
          {runtime.map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-brand-label">{label}</dt>
              <dd className="mt-0.5 font-mono text-sm break-all text-brand-text">
                {value}
              </dd>
            </div>
          ))}
          <div className="sm:col-span-2">
            <dt className="text-xs text-brand-label">{t`Capabilities`}</dt>
            <dd className="mt-0.5 font-mono text-sm break-all text-brand-muted">
              {data?.health.capabilities.join(' · ') || t`Unavailable`}
            </dd>
          </div>
        </dl>
      </section>
      <div className="grid items-start gap-8 border-t border-brand-border pt-4 xl:grid-cols-2">
        {secondary.map((group) => (
          <section key={group.name}>
            <h2 className="text-sm font-medium text-brand-muted">
              {group.name}
            </h2>
            <dl className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-2">
              {group.facts.map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs text-brand-label">{label}</dt>
                  <dd className="mt-0.5 font-mono text-sm text-brand-text">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
            {group.name === t`Host signals` ? (
              <p className="mt-2 text-xs text-brand-label">
                <ImeDetail ime={data?.ime} />
              </p>
            ) : null}
          </section>
        ))}
      </div>
    </div>
  )
}

function useRuntimeEndpoint(probe: ReturnType<typeof useRuntimeData>['probe']) {
  return probe.data?.baseUrl ?? 'http://127.0.0.1:35791'
}
