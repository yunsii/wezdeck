import { useLingui } from '@lingui/react/macro'
import { Activity, Code2, House, Server } from 'lucide-react'
import { Component } from 'react'
import type { ReactNode } from 'react'
import { Link, Outlet, useLocation } from '@tanstack/react-router'

import { Button } from '#/components/ui/button'
import { cn } from '#/lib/utils'
import { useLocale } from '#/lib/locale-context'
import { useTheme } from '#/lib/theme-provider'
import {
  RuntimeDataProvider,
  runtimeQuery,
  useRuntimeData,
} from './console-data'
import {
  LanguageSwitcher,
  StatusPill,
  ThemeSwitcher,
  formatDuration,
  formatTime,
} from './console-shared'

export function ConsoleRouteLayout() {
  return (
    <RuntimeDataProvider>
      <ConsoleShell>
        <Outlet />
      </ConsoleShell>
    </RuntimeDataProvider>
  )
}

function navClass(active: boolean) {
  return cn(
    'w-full justify-start rounded-none border-transparent px-3 text-sm text-brand-muted hover:bg-brand-soft hover:text-brand-text',
    active && 'bg-brand-soft text-brand-running',
  )
}

function ConsoleShell({ children }: { children: React.ReactNode }) {
  const { t } = useLingui()
  const { locale } = useLocale()
  const { mode, setMode } = useTheme()
  const location = useLocation().pathname
  const isDevelopment = location.endsWith('/development')
  const isDiagnostics = location.endsWith('/diagnostics')
  const localeParam = locale === 'en' ? undefined : locale

  return (
    <main className="grid h-dvh grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-brand-deck text-brand-text">
      <StatusBand />
      <div className="grid min-h-0 max-[899px]:grid-cols-1 lg:grid-cols-[calc(var(--spacing)*52)_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col overflow-hidden border-r border-brand-border bg-brand-surface max-[899px]:flex-row max-[899px]:items-center max-[899px]:overflow-x-auto max-[899px]:border-r-0 max-[899px]:border-b">
          <div className="flex items-center gap-2 px-3 py-3">
            <img src="/brand-icon.svg" alt="" width="28" height="28" />
            <div className="max-[899px]:hidden">
              <p className="text-sm font-semibold">{t`WezDeck`}</p>
              <p className="text-xs text-brand-muted">{t`Runtime Console`}</p>
            </div>
          </div>
          <nav
            className="grid min-h-0 gap-0.5 overflow-y-auto px-2 max-[899px]:flex max-[899px]:flex-1 max-[899px]:overflow-visible"
            aria-label={t`Console navigation`}
          >
            <ModeLink
              active={!isDevelopment && !isDiagnostics}
              to="/{-$locale}/console"
              locale={localeParam}
              icon={<Server size={15} aria-hidden />}
              label={t`Overview`}
            />
            <ModeLink
              active={isDevelopment}
              to="/{-$locale}/console/development"
              locale={localeParam}
              icon={<Code2 size={15} aria-hidden />}
              label={t`Development`}
            />
            <ModeLink
              active={isDiagnostics}
              to="/{-$locale}/console/diagnostics"
              locale={localeParam}
              icon={<Activity size={15} aria-hidden />}
              label={t`Diagnostics`}
            />
          </nav>
          <div className="mt-auto flex items-center gap-2 p-3 max-[899px]:mt-0">
            <Link
              to="/{-$locale}"
              params={{ locale: localeParam }}
              aria-label={t`Deck`}
              className="inline-flex size-8 items-center justify-center rounded-md border border-brand-border text-brand-muted transition hover:border-brand-running hover:text-brand-text"
            >
              <House size={15} />
            </Link>
            <LanguageSwitcher locale={locale} side="top" />
            <ThemeSwitcher mode={mode} onChange={setMode} side="top" />
          </div>
        </aside>
        <div className="min-h-0 min-w-0 overflow-y-auto">
          <a
            href="#console-main"
            className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-40 focus:bg-brand-surface focus:px-3 focus:py-2 focus:text-sm focus:ring-2 focus:ring-brand-running"
          >
            {t`Skip to content`}
          </a>
          <div id="console-main" className="p-4">
            <PageBoundary>{children}</PageBoundary>
          </div>
        </div>
      </div>
    </main>
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

function StatusBand() {
  const { t } = useLingui()
  const { data, connected, loading } = useRuntimeData()
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-brand-border bg-brand-surface px-4 py-2 text-xs">
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
      </span>
      <WakatimeStatus />
      <a
        href={
          'http://127.0.0.1:' + (data?.chrome?.port ?? 9222) + '/json/version'
        }
        target="_blank"
        rel="noreferrer"
        className="ml-auto font-mono text-brand-label hover:text-brand-text"
      >
        CDP {data?.chrome?.port ?? 9222}
        <span
          className={
            data?.chrome?.alive ? ' text-brand-done' : ' text-brand-waiting'
          }
        >
          {' '}
          {data?.chrome?.alive ? t`Ready` : t`Waiting`}
        </span>
      </a>
    </div>
  )
}

class PageBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: unknown) {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
    }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <PageError
        message={this.state.error.message}
        onRetry={() => this.setState({ error: null })}
      />
    )
  }
}

function PageError({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  const { t } = useLingui()
  return (
    <div
      role="alert"
      className="grid max-w-xl content-start gap-3 border border-brand-waiting bg-brand-waiting/10 px-3 py-3"
    >
      <p className="text-sm text-brand-text">{t`This page hit a rendering error. The rest of the console is still available.`}</p>
      <p className="font-mono text-xs break-all text-brand-muted">{message}</p>
      <Button size="sm" variant="warning" onClick={onRetry}>
        {t`Retry`}
      </Button>
    </div>
  )
}

function ModeLink({
  active,
  to,
  locale,
  icon,
  label,
}: {
  active: boolean
  to:
    | '/{-$locale}/console'
    | '/{-$locale}/console/development'
    | '/{-$locale}/console/diagnostics'
  locale: 'zh' | undefined
  icon: React.ReactNode
  label: string
}) {
  return (
    <Button
      variant="ghost"
      className={navClass(active)}
      render={
        <Link
          to={to}
          params={{ locale }}
          aria-current={active ? 'page' : undefined}
        />
      }
    >
      {icon}
      <span>{label}</span>
    </Button>
  )
}
