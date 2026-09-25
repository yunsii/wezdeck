import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useLingui } from '@lingui/react/macro'
import {
  Activity,
  CheckCircle2,
  CircleAlert,
  Keyboard,
  Languages,
  Monitor,
  Moon,
  Radio,
  RefreshCw,
  Server,
  Sun,
  WifiOff,
  Info,
} from 'lucide-react'
import { useEffect } from 'react'
import { useLocation, useNavigate } from '@tanstack/react-router'

import {
  getRuntimeSnapshot,
  probeRuntime,
  runtimeEventsUrl,
} from '#/lib/runtime-client'
import { useLocale } from '#/lib/locale-context'
import { useTheme } from '#/lib/theme-provider'
import type { ThemeMode } from '#/lib/theme-provider'
import { Button } from '#/components/ui/button'
import { Toggle, ToggleGroup } from '#/components/ui/toggle-group'
import { Tooltip } from '#/components/ui/tooltip'

export function RuntimeConsole() {
  const { t } = useLingui()
  const { locale } = useLocale()
  const { mode, setMode } = useTheme()
  const queryClient = useQueryClient()
  const snapshot = useQuery({
    queryKey: ['runtime', 'snapshot'],
    queryFn: getRuntimeSnapshot,
    enabled: typeof window !== 'undefined',
    refetchInterval: 5_000,
  })
  const probe = useQuery({
    queryKey: ['runtime', 'probe'],
    queryFn: probeRuntime,
    enabled: typeof window !== 'undefined',
    refetchInterval: 5_000,
  })

  useEffect(() => {
    const baseUrl = probe.data?.baseUrl
    if (!baseUrl || typeof window === 'undefined') return
    const socket = new WebSocket(runtimeEventsUrl(baseUrl))
    socket.onmessage = () =>
      void queryClient.invalidateQueries({ queryKey: ['runtime'] })
    return () => socket.close()
  }, [probe.data?.baseUrl, queryClient])

  const connected = Boolean(snapshot.data)
  const error =
    snapshot.error instanceof Error ? snapshot.error.message : undefined

  return (
    <main className="console-shell min-h-screen">
      <header className="console-header border-b border-brand-border bg-brand-surface">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-3 px-6 py-5">
          <div className="flex min-w-0 items-center gap-3">
            <img
              className="size-10 rounded-lg"
              src="/brand-icon.svg"
              alt=""
              width="40"
              height="40"
            />
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-brand-muted">
                {t`WezDeck`}
              </p>
              <h1 className="truncate text-xl font-semibold tracking-tight">
                {t`Runtime Console`}
              </h1>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-3">
            <LanguageSwitcher locale={locale} />
            <ThemeSwitcher mode={mode} onChange={setMode} />
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1440px] space-y-6 px-6 py-7">
        <section className="grid gap-4 md:grid-cols-3">
          <MetricPanel
            icon={<Server size={18} />}
            label={t`Runtime Console`}
            value={connected ? t`Online` : t`Offline`}
            detail={probe.data?.health.api_version ?? t`No local endpoint`}
            info={t`The local Runtime process that owns host state, actions, and the browser event stream.`}
            accent={connected ? 'lime' : 'red'}
            loading={snapshot.isPending}
          />
          <MetricPanel
            icon={<Keyboard size={18} />}
            label={t`Rime today`}
            value={formatNumber(
              snapshot.data?.rime?.today_chars ?? snapshot.data?.rime?.chars,
            )}
            detail={t`Current local day`}
            info={t`Characters committed through Rime during the current local day.`}
            accent="cyan"
            loading={snapshot.isPending}
          />
          <MetricPanel
            icon={<Radio size={18} />}
            label={t`Event stream`}
            value={probe.data ? t`Ready` : t`Waiting`}
            detail={
              probe.data
                ? t`WebSocket endpoint detected`
                : t`Waiting for Runtime`
            }
            info={t`A loopback WebSocket that tells the console when it should refresh local Runtime snapshots.`}
            accent={probe.data ? 'lime' : 'amber'}
            loading={probe.isPending}
          />
        </section>

        {error && !snapshot.isPending && !connected ? (
          <OfflineBanner
            message={error}
            onRetry={() => void snapshot.refetch()}
          />
        ) : null}

        <section className="grid gap-6 lg:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.55fr)]">
          <Panel
            title={t`Runtime snapshot`}
            icon={<Activity size={17} />}
            info={t`The local Runtime process that owns host state, actions, and the browser event stream.`}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <StatusRow
                label={t`Instance`}
                value={snapshot.data?.health.instance_id ?? 'Unavailable'}
                info={t`The Runtime process identity. It changes after a helper restart.`}
                loading={snapshot.isPending}
              />
              <StatusRow
                label={t`Capabilities`}
                value={
                  snapshot.data?.health.capabilities.join(' · ') ||
                  'Unavailable'
                }
                info={t`Read-only and action surfaces currently advertised by the Runtime API.`}
                loading={snapshot.isPending}
              />
              <StatusRow
                label={t`Last sample`}
                value={formatTime(snapshot.data?.health.observed_at)}
                info={t`The last time the Runtime API returned a health snapshot.`}
                loading={snapshot.isPending}
              />
            </div>
          </Panel>

          <Panel
            title={t`Rime commits`}
            icon={<Keyboard size={17} />}
            info={t`Characters committed through Rime during the current local day.`}
          >
            <div className="space-y-5">
              <div>
                {snapshot.isPending ? (
                  <Skeleton className="h-4 w-48" />
                ) : (
                  <p className="text-sm text-brand-muted">
                    {t`The summary above is the current day total.`}
                  </p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <MiniMetric
                  label={t`events`}
                  value={formatNumber(snapshot.data?.rime?.events)}
                  info={t`Number of commit events recorded by the Rime counter.`}
                  loading={snapshot.isPending}
                />
                <MiniMetric
                  label={t`latest`}
                  value={formatTime(snapshot.data?.rime?.last_ts)}
                  info={t`Timestamp of the newest Rime commit event.`}
                  loading={snapshot.isPending}
                />
              </div>
            </div>
          </Panel>
        </section>

        <section className="grid gap-6 lg:grid-cols-2">
          <Panel
            title={t`Host signals`}
            icon={<Monitor size={17} />}
            info={t`The latest IME sample associated with the foreground WezTerm window. Non-WezTerm foregrounds are deliberately not sampled.`}
          >
            <div className="space-y-3">
              <SignalLine
                label={t`Input method`}
                state={snapshot.data?.ime?.mode ?? 'unknown'}
                detail={<ImeDetail ime={snapshot.data?.ime} />}
                info={t`The latest IME sample associated with the foreground WezTerm window. Non-WezTerm foregrounds are deliberately not sampled.`}
                loading={snapshot.isPending}
              />
              <SignalLine
                label={t`Chrome debug`}
                state={
                  snapshot.data?.chrome?.alive
                    ? 'alive'
                    : (snapshot.data?.chrome?.mode ?? 'unknown')
                }
                detail={
                  snapshot.data?.chrome?.port
                    ? `port ${snapshot.data.chrome.port}`
                    : t`No state`
                }
                info={t`The helper-owned Chrome debug instance and its CDP liveness state.`}
                loading={snapshot.isPending}
              />
            </div>
          </Panel>
          <Panel
            title={t`Connection`}
            icon={<Radio size={17} />}
            info={t`The loopback HTTP endpoint used by this page. Data stays on the local machine.`}
          >
            <div className="space-y-3">
              <StatusRow
                label={t`Endpoint`}
                value={probe.data?.baseUrl ?? 'http://127.0.0.1:35791'}
                info={t`The loopback HTTP endpoint used by this page. Data stays on the local machine.`}
                loading={probe.isPending}
              />
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => void snapshot.refetch()}
              >
                <RefreshCw size={15} /> {t`Refresh snapshot`}
              </Button>
            </div>
          </Panel>
        </section>
      </div>
    </main>
  )
}

function OfflineBanner({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  const { t } = useLingui()
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-brand-waiting bg-brand-waiting/10 px-4 py-3 text-sm text-brand-waiting">
      <span className="flex items-center gap-2">
        <WifiOff size={17} />
        {message}
      </span>
      <Button variant="warning" size="sm" onClick={onRetry}>
        {t`Retry`}
      </Button>
    </div>
  )
}

function Panel({
  title,
  icon,
  info,
  children,
}: {
  title: string
  icon: React.ReactNode
  info?: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-lg border border-brand-border bg-brand-surface p-5">
      <div className="mb-5 flex items-center gap-2 text-sm font-semibold text-brand-text">
        <span className="text-brand-muted">{icon}</span>
        {title}
        {info ? <InfoTip text={info} /> : null}
      </div>
      {children}
    </section>
  )
}

function MetricPanel({
  icon,
  label,
  value,
  detail,
  info,
  accent,
  loading = false,
}: {
  icon: React.ReactNode
  label: string
  value: string
  detail: string
  info?: string
  accent: 'lime' | 'cyan' | 'amber' | 'red'
  loading?: boolean
}) {
  const tone = {
    lime: 'text-brand-done',
    cyan: 'text-brand-running',
    amber: 'text-brand-waiting',
    red: 'text-brand-error',
  }[accent]
  return (
    <section className="rounded-lg border border-brand-border bg-brand-surface p-5">
      <div
        className={`mb-4 flex items-center gap-2 text-sm font-medium ${tone}`}
      >
        {icon}
        {label}
        {info ? <InfoTip text={info} /> : null}
      </div>
      {loading ? (
        <>
          <Skeleton className="h-7 w-24" />
          <Skeleton className="mt-2 h-4 w-32" />
        </>
      ) : (
        <>
          <p className="text-2xl font-semibold tracking-tight">{value}</p>
          <p className="mt-1 truncate text-sm text-brand-muted">{detail}</p>
        </>
      )}
    </section>
  )
}

function StatusRow({
  label,
  value,
  info,
  loading = false,
}: {
  label: string
  value: string
  info?: string
  loading?: boolean
}) {
  return (
    <div className="rounded-md border border-brand-border bg-brand-soft px-3 py-2.5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-brand-label">
        {label} {info ? <InfoTip text={info} /> : null}
      </p>
      {loading ? (
        <Skeleton className="mt-2 h-4 w-32" />
      ) : (
        <p className="mt-1 truncate text-sm text-brand-text">{value}</p>
      )}
    </div>
  )
}

function MiniMetric({
  label,
  value,
  info,
  loading = false,
}: {
  label: string
  value: string
  info?: string
  loading?: boolean
}) {
  return (
    <div className="rounded-md border border-brand-border bg-brand-soft p-3">
      <p className="text-xs text-brand-label">
        {label} {info ? <InfoTip text={info} /> : null}
      </p>
      {loading ? (
        <Skeleton className="mt-2 h-4 w-20" />
      ) : (
        <p className="mt-1 text-sm font-semibold text-brand-text">{value}</p>
      )}
    </div>
  )
}

function SignalLine({
  label,
  state,
  detail,
  info,
  loading = false,
}: {
  label: string
  state: string
  detail: React.ReactNode
  info?: string
  loading?: boolean
}) {
  const healthy = ['alive', 'active', 'ime', 'rime'].includes(
    state.toLowerCase(),
  )
  return (
    <div className="flex items-center justify-between gap-4 border-b border-brand-border pb-3 last:border-0 last:pb-0">
      <div>
        <p className="text-sm text-brand-text">
          {label} {info ? <InfoTip text={info} /> : null}
        </p>
        {loading ? (
          <Skeleton className="mt-2 h-3 w-48" />
        ) : (
          <p className="mt-1 text-xs text-brand-label">{detail}</p>
        )}
      </div>
      {loading ? (
        <Skeleton className="h-4 w-16" />
      ) : (
        <span
          className={`inline-flex items-center gap-1.5 text-xs font-semibold ${healthy ? 'text-brand-done' : 'text-brand-muted'}`}
        >
          {healthy ? <CheckCircle2 size={15} /> : <CircleAlert size={15} />}
          {state}
        </span>
      )}
    </div>
  )
}

function Skeleton({ className }: { className: string }) {
  return <span aria-hidden="true" className={`loading-skeleton ${className}`} />
}

function InfoTip({ text }: { text: string }) {
  return (
    <Tooltip content={text}>
      <Info size={14} />
    </Tooltip>
  )
}

function ImeDetail({
  ime,
}: {
  ime: { reason?: string | null } | null | undefined
}) {
  const { t } = useLingui()
  if (!ime)
    return <>{t`IME state is unavailable because the Runtime is offline.`}</>
  if (!ime.reason)
    return <>{t`Current sample is from the foreground WezTerm window.`}</>
  if (ime.reason === 'foreground_not_wezterm')
    return (
      <>{t`The foreground app is not WezTerm, so the helper is holding the last WezTerm sample.`}</>
    )
  if (ime.reason === 'no_foreground')
    return (
      <>{t`No foreground window was available when the helper sampled the IME.`}</>
    )
  return (
    <>
      {t`The helper reported reason:`} {ime.reason}
    </>
  )
}

export function ThemeSwitcher({
  mode,
  onChange,
}: {
  mode: ThemeMode
  onChange: (mode: ThemeMode) => void
}) {
  const { t } = useLingui()
  const items: Array<[ThemeMode, React.ReactNode, string]> = [
    ['light', <Sun size={15} />, t`Light theme`],
    ['dark', <Moon size={15} />, t`Dark theme`],
    ['system', <Monitor size={15} />, t`Follow system theme`],
  ]
  return (
    <ToggleGroup
      className="theme-switcher"
      aria-label={t`Theme`}
      value={[mode]}
      onValueChange={(values) => {
        onChange(values[0])
      }}
    >
      {items.map(([value, icon, label]) => (
        <Toggle
          key={value}
          value={value}
          className="theme-option"
          aria-label={label}
          title={label}
          suppressHydrationWarning
        >
          {icon}
        </Toggle>
      ))}
    </ToggleGroup>
  )
}

export function LanguageSwitcher({ locale }: { locale: string }) {
  const { t } = useLingui()
  const navigate = useNavigate()
  const location = useLocation()
  const inConsole =
    location.pathname === '/console' ||
    location.pathname.startsWith('/zh/console')
  const englishPath = inConsole ? '/console' : '/'
  const chinesePath = inConsole ? '/zh/console' : '/zh'
  return (
    <ToggleGroup
      className="language-switcher"
      aria-label={t`Language`}
      value={[locale]}
      onValueChange={(values) => {
        const nextLocale = values[0]
        if (nextLocale === 'en') void navigate({ to: englishPath })
        if (nextLocale === 'zh') void navigate({ to: chinesePath })
      }}
    >
      <Languages size={15} />
      <Toggle value="en" className="language-option">
        {t`English`}
      </Toggle>
      <Toggle value="zh" className="language-option">
        {t`中文`}
      </Toggle>
    </ToggleGroup>
  )
}

function formatNumber(value: number | undefined) {
  return value === undefined ? '—' : new Intl.NumberFormat().format(value)
}

function formatTime(value: string | undefined | null) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.valueOf())
    ? value
    : date.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
}
