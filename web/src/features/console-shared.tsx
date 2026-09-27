import { useLingui } from '@lingui/react/macro'
import {
  Check,
  CheckCircle2,
  CircleAlert,
  Info,
  Languages,
  Monitor,
  Palette,
  Moon,
  Sun,
} from 'lucide-react'
import { useNavigate, useParams } from '@tanstack/react-router'

import { Badge } from '#/components/ui/badge'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
import { Card, CardContent, CardHeader, CardTitle } from '#/components/ui/card'
import { Skeleton } from '#/components/ui/skeleton'
import { Toggle } from '#/components/ui/toggle'
import { ToggleGroup } from '#/components/ui/toggle-group'
import { Tooltip } from '#/components/ui/tooltip'
import type { ImeState } from '#/lib/runtime-contract'
import type { ThemeMode } from '#/lib/theme-provider'
import { cn } from '#/lib/utils'
import { useRuntimeData } from './console-data'

export type CheckStatus = 'loading' | 'ready' | 'warning' | 'offline'

export function Panel({
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
    <Card className="border-t-brand-running/50">
      <CardHeader className="border-b border-brand-border pb-3">
        <span className="text-brand-running">{icon}</span>
        <CardTitle className="font-medium tracking-tight">{title}</CardTitle>
        {info ? <InfoTip text={info} /> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

export function CategoryHeading({
  title,
  description,
}: {
  number?: string
  title: string
  description?: string
}) {
  return (
    <div className="mb-3.5 flex items-end justify-between gap-6 max-[899px]:flex-col max-[899px]:items-start max-[899px]:gap-1.5">
      <h2 className="text-lg font-semibold text-brand-text">{title}</h2>
      {description ? (
        <p className="max-w-xl text-right text-xs leading-normal text-brand-muted max-[899px]:text-left">
          {description}
        </p>
      ) : null}
    </div>
  )
}

export function ConsolePageHeader({
  title,
  description,
}: {
  title: string
  description: string
}) {
  const { t } = useLingui()
  const { data, connected, loading } = useRuntimeData()
  return (
    <Card
      className={cn(
        'grid items-center gap-7 border-t-2 border-t-brand-running px-6 py-5 max-[899px]:grid-cols-1 lg:grid-cols-[minmax(0,1fr)_auto]',
      )}
    >
      <div className="min-w-0">
        <div className="mb-2 flex items-center gap-3">
          <StatusPill
            status={loading ? 'loading' : connected ? 'ready' : 'offline'}
          />
          <span className="text-xs text-brand-label">
            {data?.health.api_version ?? 'v1'}
          </span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-brand-text sm:text-3xl">
          {title}
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-brand-muted">
          {description}
        </p>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-3 text-[length:var(--text-nav)] text-brand-text">
        <div className="grid gap-1">
          <span className="text-xs text-brand-label">{t`Last sample`}</span>
          <strong className="font-mono text-sm font-medium tabular-nums">
            {formatTime(data?.health.observed_at)}
          </strong>
        </div>
        <div className="grid gap-1">
          <span className="text-xs text-brand-label">{t`Uptime`}</span>
          <strong className="font-mono text-sm font-medium tabular-nums">
            {formatDuration(data?.health.uptime_ms)}
          </strong>
        </div>
      </div>
    </Card>
  )
}

export function MetricPanel({
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
  accent: 'lime' | 'cyan' | 'amber' | 'red' | 'violet'
  loading?: boolean
}) {
  const tone = {
    lime: 'text-brand-done',
    cyan: 'text-brand-running',
    amber: 'text-brand-waiting',
    red: 'text-brand-error',
    violet: 'text-brand-violet',
  }[accent]
  return (
    <Card className="min-h-36">
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
          <Skeleton className="mt-2 h-4 w-36" />
        </>
      ) : (
        <>
          <p className="text-2xl font-semibold tracking-tight tabular-nums">
            {value}
          </p>
          <p className="mt-1 truncate text-sm text-brand-muted">{detail}</p>
        </>
      )}
    </Card>
  )
}

export function MiniMetric({
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
    <div className="min-w-0 border border-brand-border bg-brand-deck px-3 py-2.5">
      <p className="text-xs text-brand-label">
        {label} {info ? <InfoTip text={info} /> : null}
      </p>
      {loading ? (
        <Skeleton className="mt-2 h-4 w-20" />
      ) : (
        <p className="mt-1 font-mono text-sm font-medium text-brand-text tabular-nums">
          {value}
        </p>
      )}
    </div>
  )
}

export function StatusPill({
  status,
  compact = false,
}: {
  status: CheckStatus
  compact?: boolean
}) {
  const { t } = useLingui()
  const labels = {
    loading: t`Loading…`,
    ready: t`Ready`,
    warning: t`Degraded`,
    offline: t`Offline`,
  }
  return (
    <Badge variant={status} size={compact ? 'sm' : 'default'}>
      <span
        className={cn(
          'size-1.5 rounded-full bg-current',
          status === 'loading' && 'motion-safe:animate-pulse',
        )}
      />
      {labels[status]}
    </Badge>
  )
}

export function StatusIcon({ status }: { status: CheckStatus }) {
  if (status === 'loading')
    return (
      <span className="inline-block size-4.25 animate-spin rounded-full border-2 border-brand-border border-t-brand-running" />
    )
  if (status === 'ready')
    return <CheckCircle2 size={17} className="text-brand-done" />
  return (
    <CircleAlert
      size={17}
      className={
        status === 'offline' ? 'text-brand-error' : 'text-brand-waiting'
      }
    />
  )
}

export function StatusRow({
  label,
  value,
  info,
  loading = false,
  className = '',
}: {
  label: string
  value: string
  info?: string
  loading?: boolean
  className?: string
}) {
  return (
    <div
      className={cn(
        'min-h-17.5 min-w-0 border border-brand-border bg-brand-deck p-3',
        className,
      )}
    >
      <p className="font-mono text-[length:var(--text-kicker)] text-brand-label">
        {label} {info ? <InfoTip text={info} /> : null}
      </p>
      {loading ? (
        <Skeleton className="mt-2 h-4 w-32" />
      ) : (
        <p className="mt-1 truncate font-mono text-sm text-brand-text">
          {value}
        </p>
      )}
    </div>
  )
}

export function SignalLine({
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
  const healthy = ['alive', 'active', 'ime', 'rime', 'native'].includes(
    state.toLowerCase(),
  )
  return (
    <div className="flex items-center justify-between gap-4 border-b border-brand-border py-3 first:pt-0 last:border-0 last:pb-0">
      <div className="min-w-0">
        <p className="text-sm text-brand-text">
          {label} {info ? <InfoTip text={info} /> : null}
        </p>
        {loading ? (
          <Skeleton className="mt-2 h-3 w-48" />
        ) : (
          <p className="mt-1 truncate text-xs text-brand-label">{detail}</p>
        )}
      </div>
      {loading ? (
        <Skeleton className="h-4 w-16" />
      ) : (
        <span
          className={`inline-flex shrink-0 items-center gap-1.5 text-xs font-semibold ${healthy ? 'text-brand-done' : 'text-brand-muted'}`}
        >
          {healthy ? <Check size={14} /> : <CircleAlert size={14} />}
          {state}
        </span>
      )}
    </div>
  )
}

export function InfoTip({ text }: { text: string }) {
  return (
    <Tooltip content={text}>
      <Info size={14} />
    </Tooltip>
  )
}

export function EmptyPanelState({
  text,
  detail,
}: {
  text: string
  detail: string
}) {
  return (
    <div className="border border-dashed border-brand-border bg-brand-deck px-4 py-5">
      <p className="text-sm font-medium text-brand-text">{text}</p>
      <p className="mt-1 text-xs text-brand-label">{detail}</p>
    </div>
  )
}

export function ImeDetail({ ime }: { ime: ImeState | null | undefined }) {
  const { t } = useLingui()
  if (!ime)
    return <>{t`IME state is unavailable because Runtime is offline.`}</>
  if (!ime.reason)
    return <>{t`Current sample is from the foreground WezTerm window.`}</>
  if (ime.reason === 'foreground_not_wezterm')
    return (
      <>{t`The foreground app is not WezTerm, so Runtime is holding the last WezTerm sample.`}</>
    )
  if (ime.reason === 'no_foreground')
    return (
      <>{t`No foreground window was available when Runtime sampled the IME.`}</>
    )
  return (
    <>
      {t`Runtime reported reason:`} {ime.reason}
    </>
  )
}

export function ThemeSwitcher({
  mode,
  onChange,
  side = 'bottom',
}: {
  mode: ThemeMode
  onChange: (mode: ThemeMode) => void
  side?: 'top' | 'bottom'
}) {
  const { t } = useLingui()
  const items: Array<[ThemeMode, React.ReactNode, string]> = [
    ['light', <Sun size={15} />, t`Light theme`],
    ['dark', <Moon size={15} />, t`Dark theme`],
    ['system', <Monitor size={15} />, t`Follow system theme`],
  ]
  return (
    <OptionMenu label={t`Theme`} icon={<Palette size={15} />} side={side}>
      <ToggleGroup
        aria-label={t`Theme`}
        value={[mode]}
        onValueChange={(values) => {
          const next = values[0]
          if (next === 'light' || next === 'dark' || next === 'system')
            onChange(next)
        }}
      >
        {items.map(([value, icon, label]) => (
          <Toggle
            key={value}
            value={value}
            size="icon"
            aria-label={label}
            title={label}
            suppressHydrationWarning
          >
            {icon}
          </Toggle>
        ))}
      </ToggleGroup>
    </OptionMenu>
  )
}

export function LanguageSwitcher({
  locale,
  side = 'bottom',
}: {
  locale: string
  side?: 'top' | 'bottom'
}) {
  const { t } = useLingui()
  const navigate = useNavigate()
  const params = useParams({ strict: false })
  return (
    <OptionMenu label={t`Language`} icon={<Languages size={15} />} side={side}>
      <ToggleGroup
        aria-label={t`Language`}
        value={[locale]}
        onValueChange={(values) => {
          const next = values[0]
          if (next !== 'en' && next !== 'zh') return
          void navigate({
            to: '.',
            params: { ...params, locale: next === 'en' ? undefined : next },
          })
        }}
      >
        <Toggle value="en" size="default">{t`English`}</Toggle>
        <Toggle value="zh" size="default">{t`中文`}</Toggle>
      </ToggleGroup>
    </OptionMenu>
  )
}

function OptionMenu({
  label,
  icon,
  side,
  children,
}: {
  label: string
  icon: React.ReactNode
  side: 'top' | 'bottom'
  children: React.ReactNode
}) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={80}
        closeDelay={120}
        aria-label={label}
        className="inline-flex size-8 items-center justify-center rounded-md border border-brand-border text-brand-muted transition hover:border-brand-running hover:text-brand-text data-popup-open:border-brand-running data-popup-open:bg-brand-soft data-popup-open:text-brand-text"
      >
        {icon}
      </PopoverTrigger>
      <PopoverContent side={side}>{children}</PopoverContent>
    </Popover>
  )
}

export function formatNumber(value: number | undefined) {
  return value === undefined ? '—' : new Intl.NumberFormat().format(value)
}
export function formatTime(value: string | undefined | null) {
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
export function formatDuration(value: number | undefined) {
  if (value === undefined) return '—'
  const totalMinutes = Math.floor(value / 60_000)
  const days = Math.floor(totalMinutes / 1_440)
  const hours = Math.floor((totalMinutes % 1_440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}
