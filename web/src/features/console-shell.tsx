import { useLingui } from '@lingui/react/macro'
import {
  Activity,
  Code2,
  GitPullRequestArrow,
  House,
  CircleDot,
  ListTree,
  MessagesSquare,
  Server,
  UserRound,
} from 'lucide-react'
import { Component, useCallback, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router'

import { Button } from '#/components/ui/button'
import { useCollab } from '#/lib/collab-query'
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
import { useConsoleMode } from './console-mode'
import { RemoteBadge } from './remote-badge'
import { remoteLink } from '#/lib/remote-link'

export function ConsoleRouteLayout() {
  return (
    <RuntimeDataProvider>
      <ConsoleShell>
        <Outlet />
      </ConsoleShell>
    </RuntimeDataProvider>
  )
}

type Section =
  | 'overview'
  | 'development'
  | 'diagnostics'
  | 'now'
  | 'inbox'
  | 'collab'
  | 'sessions'
  | 'activity'
  | 'me'

const SECTION_PATH = {
  overview: '/{-$locale}/console',
  development: '/{-$locale}/console/development',
  diagnostics: '/{-$locale}/console/diagnostics',
  now: '/{-$locale}/console/now',
  inbox: '/{-$locale}/console/inbox',
  collab: '/{-$locale}/console/collab',
  sessions: '/{-$locale}/console/sessions',
  activity: '/{-$locale}/console/activity',
  me: '/{-$locale}/console/me',
} as const

/** `g` + letter jumps (keyboard-first stance); shown in sidebar titles. */
const JUMP_KEYS: Partial<Record<string, Section>> = {
  o: 'overview',
  d: 'development',
  x: 'diagnostics',
  n: 'now',
  c: 'collab',
  s: 'sessions',
  a: 'activity',
  m: 'me',
}

function sectionOf(pathname: string): Section {
  const rest = pathname
    .replace(/^\/(zh|en)(?=\/)/, '')
    .replace(/^\/console\/?/, '')
  const first = rest.split('/')[0]
  return (
    first in SECTION_PATH ? first : first === '' ? 'overview' : 'collab'
  ) as Section
}

function useSections() {
  const { t } = useLingui()
  const mode = useConsoleMode()
  const all: Array<{
    id: Section
    label: string
    icon: ReactNode
    local?: boolean
  }> = [
    {
      id: 'overview',
      label: t`Overview`,
      icon: <Server size={16} aria-hidden />,
      local: true,
    },
    {
      id: 'development',
      label: t`Development`,
      icon: <Code2 size={16} aria-hidden />,
      local: true,
    },
    {
      id: 'diagnostics',
      label: t`Diagnostics`,
      icon: <Activity size={16} aria-hidden />,
      local: true,
    },
    { id: 'now', label: t`Now`, icon: <CircleDot size={16} aria-hidden /> },
    {
      id: 'collab',
      label: t`Tickets`,
      icon: <GitPullRequestArrow size={16} aria-hidden />,
    },
    {
      id: 'sessions',
      label: t({ message: 'Sessions', context: 'nav' }),
      icon: <MessagesSquare size={16} aria-hidden />,
    },
    {
      id: 'activity',
      label: t`Activity`,
      icon: <ListTree size={16} aria-hidden />,
    },
    { id: 'me', label: t`Settings`, icon: <UserRound size={16} aria-hidden /> },
  ]
  return {
    mode,
    sidebar: all.filter((item) => mode === 'local' || !item.local),
    tabs: all.filter((item) =>
      ['now', 'collab', 'sessions', 'me'].includes(item.id),
    ),
  }
}

function useJumpKeys(go: (section: Section) => void) {
  useEffect(() => {
    let armed = 0
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.closest('input, textarea, select, [contenteditable="true"]')
      )
        return
      if (event.key === '/') {
        const box = document.querySelector<HTMLInputElement>('[data-search]')
        if (box) {
          event.preventDefault()
          box.focus()
        }
        return
      }
      if (event.key === 'g') {
        armed = Date.now()
        return
      }
      const section = JUMP_KEYS[event.key]
      if (armed && Date.now() - armed < 1200 && section) {
        event.preventDefault()
        go(section)
      }
      armed = 0
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go])
}

function ConsoleShell({ children }: { children: React.ReactNode }) {
  const { t } = useLingui()
  const { locale } = useLocale()
  const { mode: theme, setMode } = useTheme()
  const location = useLocation().pathname
  const navigate = useNavigate()
  const client = useQueryClient()
  const current = sectionOf(location)
  const localeParam = locale === 'en' ? undefined : locale
  const { mode, sidebar, tabs } = useSections()
  const health = useCollab('health', {}, { refetchInterval: 15_000 })
  const waiting = health.data?.waiting_human ?? 0
  const scroller = useRef<HTMLDivElement>(null)
  const go = useCallback(
    (section: Section) =>
      void navigate({
        to: SECTION_PATH[section],
        params: { locale: localeParam },
      }),
    [navigate, localeParam],
  )
  useJumpKeys(go)
  const title = [...sidebar, ...tabs].find((item) => item.id === current)?.label
  // Start the remote link (adopts a #pair= token) on every console page, not
  // only when a collab read happens: settings and sessions need it too.
  useEffect(() => remoteLink.start(), [])
  // ticket / session detail pages bring their own back bar instead of a title
  const detail = /\/console\/(collab|inbox|sessions)\/[^/]+$/.test(location)
  // the host overview needs the local Runtime; remote devices start at 现在
  useEffect(() => {
    if (mode === 'remote' && current === 'overview')
      void navigate({
        to: SECTION_PATH.now,
        params: { locale: localeParam },
        replace: true,
      })
  }, [mode, current, navigate, localeParam])

  return (
    <main
      data-deck
      className="grid h-dvh grid-rows-[minmax(0,1fr)_auto] overflow-hidden bg-brand-deck text-brand-text md:grid-rows-[auto_minmax(0,1fr)]"
    >
      {/* top: status band (wide, local) / remote band (wide) / phone top bar */}
      <div className="hidden md:block">
        {mode === 'local' ? <StatusBand /> : <RemoteBand />}
      </div>
      <div className="grid min-h-0 md:grid-cols-[calc(var(--spacing)*52)_minmax(0,1fr)]">
        <aside className="hidden min-h-0 flex-col overflow-hidden border-r border-brand-edge bg-brand-deck md:flex">
          <div className="flex items-center gap-2 px-3 py-3">
            <img src="/brand-icon.svg" alt="" width="28" height="28" />
            <div>
              <p className="text-sm font-semibold">{t`WezDeck`}</p>
              <p className="text-xs text-brand-muted">
                {mode === 'local' ? t`Runtime Console` : t`Remote`}
              </p>
            </div>
          </div>
          <nav
            className="grid min-h-0 content-start gap-1.5 overflow-y-auto px-2.5"
            aria-label={t`Console navigation`}
          >
            {sidebar.map((item) => {
              const active = current === item.id
              const jump = Object.entries(JUMP_KEYS).find(
                ([, section]) => section === item.id,
              )?.[0]
              return (
                <Link
                  key={item.id}
                  to={SECTION_PATH[item.id]}
                  params={{ locale: localeParam }}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex min-h-9 items-center gap-2.5 rounded-[10px] px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-brand-running',
                    active
                      ? 'bg-brand-surface font-semibold text-brand-text'
                      : 'text-brand-muted hover:bg-brand-soft',
                  )}
                >
                  <span>{item.icon}</span>
                  <span className="flex-1">{item.label}</span>
                  {item.id === 'now' && waiting > 0 ? (
                    <CountBadge value={waiting} />
                  ) : jump ? (
                    <kbd className="text-[11px] text-brand-label">g {jump}</kbd>
                  ) : null}
                </Link>
              )
            })}
          </nav>
          <div className="mt-auto flex items-center gap-2 p-3">
            <Link
              to="/{-$locale}"
              params={{ locale: localeParam }}
              aria-label={t`Deck`}
              className="inline-flex size-8 items-center justify-center rounded-md border border-brand-border text-brand-muted transition hover:border-brand-running hover:text-brand-text"
            >
              <House size={15} />
            </Link>
            <LanguageSwitcher locale={locale} side="top" />
            <ThemeSwitcher mode={theme} onChange={setMode} side="top" />
          </div>
        </aside>
        <div
          ref={scroller}
          className="min-h-0 min-w-0 overflow-y-auto overscroll-contain"
        >
          <a
            href="#console-main"
            className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-40 focus:bg-brand-surface focus:px-3 focus:py-2 focus:text-sm focus:ring-2 focus:ring-brand-running"
          >
            {t`Skip to content`}
          </a>
          <div
            id="console-main"
            className="min-h-full px-4 pt-[max(env(safe-area-inset-top),0.75rem)] pb-4 md:pt-4"
          >
            {detail ? null : (
              <div className="mb-3 flex items-center justify-between gap-3 pt-2 md:hidden">
                <h1 className="min-w-0 truncate text-[32px] leading-tight font-bold tracking-tight">
                  {title ?? t`WezDeck`}
                </h1>
                <Link
                  to="/{-$locale}/console/me"
                  params={{ locale: localeParam }}
                  aria-label={t`Connection details`}
                  className="shrink-0"
                >
                  <RemoteBadge compact />
                </Link>
              </div>
            )}
            <PageBoundary>{children}</PageBoundary>
          </div>
        </div>
      </div>
      <nav
        aria-label={t`Sections`}
        className={cn(
          'grid grid-cols-4 border-t border-brand-edge bg-[var(--bar-bg)] pt-1.5 pb-[max(env(safe-area-inset-bottom),0.5rem)] backdrop-blur md:hidden',
          // detail pages are full screen (like a chat): back bar on top, no tabs
          detail && 'hidden',
        )}
      >
        {tabs.map((item) => {
          const active = current === item.id
          return (
            <Link
              key={item.id}
              to={SECTION_PATH[item.id]}
              params={{ locale: localeParam }}
              replace
              aria-current={active ? 'page' : undefined}
              onClick={(event) => {
                if (!active) return
                // Re-tap the current tab: back to top + refresh (no pull-to-refresh).
                event.preventDefault()
                scroller.current?.scrollTo({ top: 0, behavior: 'smooth' })
                void client.invalidateQueries({
                  queryKey: ['runtime', 'collab'],
                })
                void client.invalidateQueries({ queryKey: ['remote'] })
              }}
              className={cn(
                'relative flex min-h-12 flex-col items-center justify-center gap-0.5 text-[11px]',
                active ? 'font-semibold text-brand-text' : 'text-brand-label',
              )}
            >
              <span className="[&>svg]:size-6">{item.icon}</span>
              <span>{item.label}</span>
              {item.id === 'now' && waiting > 0 ? (
                <span className="absolute top-0.5 left-[calc(50%+4px)]">
                  <CountBadge value={waiting} />
                </span>
              ) : null}
            </Link>
          )
        })}
      </nav>
    </main>
  )
}

function CountBadge({ value }: { value: number }) {
  return (
    <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-brand-waiting px-1.5 text-[11px] leading-5 font-semibold text-[#1b1406]">
      {value > 99 ? '99+' : value}
    </span>
  )
}

function RemoteBand() {
  const { t } = useLingui()
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-brand-border bg-brand-surface px-4 py-2 text-xs">
      <span className="text-brand-label">{t`Remote access`}</span>
      <RemoteBadge />
    </div>
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
