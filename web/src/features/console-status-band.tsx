// Top desktop status band for the console shell (local Runtime health,
// WakaTime and browser slot, or remote connection badge).
import { useLingui } from '@lingui/react/macro'

import { runtimeQuery, useRuntimeData } from './console-data'
import { StatusPill, formatDuration, formatTime } from './console-shared'
import { RemoteBadge } from './remote-badge'
import { RECENT_START_MS } from './runtime-restart'

export function RemoteBand() {
  const { t } = useLingui()
  return (
    <div className="flex h-full flex-nowrap items-center gap-x-3 overflow-hidden px-3 text-meta whitespace-nowrap">
      <span className="text-brand-label">{t`Remote access`}</span>
      <RemoteBadge className="min-h-5 bg-transparent px-0" />
    </div>
  )
}

/**
 * The browser slot, by its backend (docs/browser-debug.md): ego → whether Ego
 * was last seen alive; cdp → the debug Chrome's port when it answers. The
 * other side is off on purpose, so nothing is shown for it.
 */
function BrowserSlotStatus() {
  const { t } = useLingui()
  const runtime = useRuntimeData()
  const slot = runtimeQuery(runtime.browser).data
  const chrome = runtime.data?.chrome
  if (slot?.backend === 'ego')
    return (
      <span className="ml-auto font-mono text-brand-label">
        Ego
        <span
          className={slot.ego_alive ? 'text-brand-done' : 'text-brand-label'}
        >
          {' '}
          {slot.ego_alive ? t`Running` : t`Not running`}
        </span>
      </span>
    )
  if (!chrome?.alive) return null
  return (
    <a
      href={'http://127.0.0.1:' + chrome.port + '/json/version'}
      target="_blank"
      rel="noreferrer"
      className="ml-auto font-mono text-brand-label hover:text-brand-text"
    >
      CDP {chrome.port}
      <span className="text-brand-done"> {t`Ready`}</span>
    </a>
  )
}

function WakatimeStatus() {
  const { t } = useLingui()
  const wakatime = runtimeQuery(useRuntimeData().wakatime)
  if (!wakatime.data?.available) return null
  return (
    <span className="font-mono text-brand-label">
      {t`WakaTime`}
      {wakatime.data.ai ? (
        <strong className="ml-2 font-medium text-brand-text">
          AI {wakatime.data.ai}
        </strong>
      ) : null}
      {wakatime.data.code ? (
        <strong className="ml-2 font-medium text-brand-text">
          Code {wakatime.data.code}
        </strong>
      ) : null}
    </span>
  )
}

export function StatusBand() {
  const { t } = useLingui()
  const { data, connected, loading } = useRuntimeData()
  return (
    <div className="flex h-full flex-nowrap items-center gap-x-4 overflow-hidden px-3 text-meta whitespace-nowrap">
      <StatusPill
        compact
        status={loading ? 'loading' : connected ? 'ready' : 'offline'}
      />
      <span className="text-brand-label">
        {t`Last sample`}{' '}
        <strong className="font-mono font-medium text-brand-text">
          {formatTime(data?.health.observed_at)}
        </strong>
      </span>
      <span className="text-brand-label">
        {t`Uptime`}{' '}
        <strong className="font-mono font-medium text-brand-text">
          {formatDuration(data?.health.uptime_ms)}
        </strong>
        {connected &&
        data?.health.uptime_ms !== undefined &&
        data.health.uptime_ms < RECENT_START_MS ? (
          <span
            data-testid="runtime-recent-start"
            title={t`The local Runtime started a few minutes ago (a runtime sync restarts it)`}
            className="ml-1.5 text-brand-waiting"
          >
            {t`just restarted`}
          </span>
        ) : null}
      </span>
      <WakatimeStatus />
      <BrowserSlotStatus />
    </div>
  )
}
