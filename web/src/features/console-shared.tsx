import { useLingui } from '@lingui/react/macro'
import {
  Check,
  CheckCircle2,
  CircleAlert,
  Info,
  Languages,
  Palette,
} from 'lucide-react'
import { useNavigate, useParams } from '@tanstack/react-router'

import { Segmented } from '#/components/deck/segmented'
import { Badge } from '#/components/ui/badge'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
import { Card, CardContent, CardHeader, CardTitle } from '#/components/ui/card'
import { Skeleton, SkeletonGroup } from '#/components/ui/skeleton'
import { Tooltip } from '#/components/ui/tooltip'
import type { ImeState } from '#/lib/runtime-contract'
import type { ThemeMode } from '#/lib/theme-provider'
import { rememberLocale } from '#/lib/locale-pref'
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
    <div className="mb-3.5 flex items-end justify-between gap-6 max-md:flex-col max-md:items-start max-md:gap-1.5">
      <h2 className="text-heading font-semibold text-brand-text">{title}</h2>
      {description ? (
        <p className="max-w-xl text-right text-meta leading-normal text-brand-muted max-md:text-left">
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
        'grid items-center gap-7 border-t-2 border-t-brand-running px-6 py-5 max-md:grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto]',
      )}
    >
      <div className="min-w-0">
        <div className="mb-2 flex items-center gap-3">
          <StatusPill
            status={loading ? 'loading' : connected ? 'ready' : 'offline'}
          />
          <span className="text-meta text-brand-label">
            {data?.health.api_version ?? 'v1'}
          </span>
        </div>
        <h1 className="text-display font-semibold tracking-tight text-brand-text sm:text-3xl">
          {title}
        </h1>
        <p className="mt-2 max-w-3xl text-caption leading-6 text-brand-muted">
          {description}
        </p>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-3 text-caption text-brand-text">
        <div className="grid gap-1">
          <span className="text-meta text-brand-label">{t`Last sample`}</span>
          <strong className="font-mono text-body font-medium tabular-nums">
            {formatTime(data?.health.observed_at)}
          </strong>
        </div>
        <div className="grid gap-1">
          <span className="text-meta text-brand-label">{t`Uptime`}</span>
          <strong className="font-mono text-body font-medium tabular-nums">
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
        className={`mb-4 flex items-center gap-2 text-body font-medium ${tone}`}
      >
        {icon}
        {label}
        {info ? <InfoTip text={info} /> : null}
      </div>
      {loading ? (
        <SkeletonGroup>
          <Skeleton className="h-7 w-24" />
          <Skeleton className="mt-2 h-4 w-36" />
        </SkeletonGroup>
      ) : (
        <>
          <p className="text-display font-semibold tracking-tight tabular-nums">
            {value}
          </p>
          <p className="mt-1 truncate text-caption text-brand-muted">
            {detail}
          </p>
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
      <p className="text-meta text-brand-label">
        {label} {info ? <InfoTip text={info} /> : null}
      </p>
      {loading ? (
        <SkeletonGroup className="mt-2">
          <Skeleton className="h-4 w-20" />
        </SkeletonGroup>
      ) : (
        <p className="mt-1 font-mono text-body font-medium text-brand-text tabular-nums">
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
      <p className="font-mono text-meta text-brand-label">
        {label} {info ? <InfoTip text={info} /> : null}
      </p>
      {loading ? (
        <SkeletonGroup className="mt-2">
          <Skeleton className="h-4 w-32" />
        </SkeletonGroup>
      ) : (
        <p className="mt-1 truncate font-mono text-body text-brand-text">
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
        <p className="text-body text-brand-text">
          {label} {info ? <InfoTip text={info} /> : null}
        </p>
        {loading ? (
          <SkeletonGroup className="mt-2">
            <Skeleton className="h-3 w-48" />
          </SkeletonGroup>
        ) : (
          <p className="mt-1 truncate text-meta text-brand-label">{detail}</p>
        )}
      </div>
      {loading ? (
        <SkeletonGroup>
          <Skeleton className="h-4 w-16" />
        </SkeletonGroup>
      ) : (
        <span
          className={`inline-flex shrink-0 items-center gap-1.5 text-meta font-semibold ${healthy ? 'text-brand-done' : 'text-brand-muted'}`}
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
      <p className="text-body font-medium text-brand-text">{text}</p>
      <p className="mt-1 text-meta text-brand-label">{detail}</p>
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
  // the same control as 我的 › 外观: ink segments, a white thumb, words
  return (
    <OptionMenu label={t`Theme`} icon={<Palette size={16} />} side={side}>
      <Segmented
        label={t`Theme`}
        value={mode}
        onChange={onChange}
        className="w-60"
        options={[
          { value: 'system', label: t`System` },
          { value: 'light', label: t`Light` },
          { value: 'dark', label: t`Dark` },
        ]}
      />
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
    <OptionMenu label={t`Language`} icon={<Languages size={16} />} side={side}>
      <Segmented
        label={t`Language`}
        value={locale === 'zh' ? 'zh' : 'en'}
        className="w-48"
        onChange={(next) => {
          rememberLocale(next)
          void navigate({
            to: '.',
            params: { ...params, locale: next === 'en' ? undefined : next },
            // a language switch is the same page: no new history entry
            replace: true,
          })
        }}
        options={[
          { value: 'zh', label: '中文' },
          { value: 'en', label: 'English' },
        ]}
      />
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
      {/* a click, not a hover: passing the pointer over it used to pop the
          menu open and leave the button outlined */}
      <PopoverTrigger
        aria-label={label}
        className="inline-flex size-9 items-center justify-center rounded-full text-brand-muted outline-none transition-colors hover:bg-brand-soft hover:text-brand-text focus-visible:ring-2 focus-visible:ring-brand-running data-popup-open:bg-brand-soft data-popup-open:text-brand-text"
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
