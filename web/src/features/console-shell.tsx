import { useLingui } from '@lingui/react/macro'
import {
  Activity,
  GitPullRequestArrow,
  ListTree,
  MessagesSquare,
  UserRound,
} from 'lucide-react'
import { Component, useCallback, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, Outlet, useRouter, useRouterState } from '@tanstack/react-router'

import { Button } from '#/components/ui/button'
import { useTicketSync } from '#/lib/ticket-sync'
import { useGoToTab } from '#/lib/go-to-tab'
import { cn } from '#/lib/utils'
import { useLocale } from '#/lib/locale-context'
import {
  RuntimeDataProvider,
  runtimeQuery,
  useRuntimeData,
} from './console-data'
import { StatusPill, formatDuration, formatTime } from './console-shared'
import { resetSessionOrder } from './session-stable'
import { useLayoutMode } from './console-mode'
import { JUMP_KEYS, useJumpKeys } from './console-jump-keys'
import { KeysEntry } from './console-keys'
import { RemoteBadge } from './remote-badge'
import { needsYou, useSessions } from './console-sessions'
import { installClientTrace } from '#/lib/client-trace'
import { RECENT_START_MS } from './runtime-restart'
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

export type Section =
  'diagnostics' | 'inbox' | 'collab' | 'sessions' | 'activity' | 'me'

const SECTION_PATH = {
  diagnostics: '/{-$locale}/console/diagnostics',
  inbox: '/{-$locale}/console/inbox',
  collab: '/{-$locale}/console/collab',
  sessions: '/{-$locale}/console/sessions',
  activity: '/{-$locale}/console/activity',
  me: '/{-$locale}/console/me',
} as const

function sectionOf(pathname: string): Section {
  const rest = pathname
    .replace(/^\/(zh|en)(?=\/)/, '')
    .replace(/^\/console\/?/, '')
  const first = rest.split('/')[0]
  return (
    first in SECTION_PATH ? first : first === '' ? 'sessions' : 'collab'
  ) as Section
}

function useSections() {
  const { t } = useLingui()
  // layout: last time's mode while the first probe runs (no pop-in)
  const mode = useLayoutMode()
  const all: Array<{
    id: Section
    label: string
    icon: ReactNode
    local?: boolean
  }> = [
    {
      id: 'sessions',
      label: t({ message: 'Sessions', context: 'nav' }),
      icon: <MessagesSquare size={16} aria-hidden />,
    },
    {
      id: 'collab',
      label: t`Tickets`,
      icon: <GitPullRequestArrow size={16} aria-hidden />,
    },
    {
      id: 'activity',
      label: t`Ticket activity`,
      icon: <ListTree size={16} aria-hidden />,
    },
    {
      id: 'diagnostics',
      label: t`Diagnostics`,
      icon: <Activity size={16} aria-hidden />,
      local: true,
    },
    { id: 'me', label: t`Settings`, icon: <UserRound size={16} aria-hidden /> },
  ]
  return {
    mode,
    sidebar: all.filter((item) => mode === 'local' || !item.local),
    // phone tabs, in this order: 会话 is the home
    tabs: (['sessions', 'collab', 'me'] as const).map((id) =>
      all.find((item) => item.id === id)!,
    ),
  }
}

/**
 * Section switches have no transition, so the next section must be ready:
 * the ticket list is kept warm by useTicketSync (the sessions list by the
 * shell's badge query; both persist to IndexedDB); this loads every
 * section's route code once idle.
 */
function useWarmSections(
  sections: Array<Section>,
  locale: 'en' | 'zh' | undefined,
) {
  const router = useRouter()
  const key = sections.join(' ')
  useEffect(() => {
    const preload = () => {
      for (const section of key.split(' ') as Array<Section>)
        void router
          .preloadRoute({ to: SECTION_PATH[section], params: { locale } })
          .catch(() => undefined)
    }
    const idle = window.requestIdleCallback as
      ((cb: () => void) => number) | undefined
    if (idle) idle(preload)
    else setTimeout(preload, 1_000)
  }, [router, locale, key])
}

function ConsoleShell({ children }: { children: React.ReactNode }) {
  const { t } = useLingui()
  const { locale } = useLocale()
  // the resolved location, not the pending one: on back the title and back
  // bar must not switch before the page does, or the leaving page's
  // transition snapshot carries the next page's header
  const location = useRouterState({
    select: (state) => (state.resolvedLocation ?? state.location).pathname,
  })
  const client = useQueryClient()
  const current = sectionOf(location)
  const localeParam = locale === 'en' ? undefined : locale
  const { mode, sidebar, tabs } = useSections()
  // drives the ticket list for every console page (lib/ticket-sync)
  const health = useTicketSync()
  // what waits on you, on the tab that holds it
  const sessions = useSessions()
  const badges: Partial<Record<Section, number>> = {
    collab: health.data?.waiting_human ?? 0,
    sessions: (sessions.data?.sessions ?? []).filter(needsYou).length,
  }
  const scroller = useRef<HTMLDivElement>(null)
  const router = useRouter()
  const goToTab = useGoToTab()
  // sections are first-level pages: they hold the first history entry only
  const hrefOf = useCallback(
    (section: Section) =>
      router.buildLocation({
        to: SECTION_PATH[section],
        params: { locale: localeParam },
      }).href,
    [router, localeParam],
  )
  const go = useCallback(
    (section: Section) => goToTab(hrefOf(section)),
    [goToTab, hrefOf],
  )
  useJumpKeys(go)
  useWarmSections(
    [...sidebar, ...tabs].map((item) => item.id),
    localeParam,
  )
  const title = [...sidebar, ...tabs].find((item) => item.id === current)?.label
  // Start the remote link (adopts a #pair= token) on every console page, not
  // only when a collab read happens: settings and sessions need it too.
  useEffect(() => {
    installClientTrace()
    return remoteLink.start()
  }, [])
  // ticket / session detail pages bring their own back bar instead of a title
  const detail = /\/console\/(collab|inbox|sessions)\/[^/]+$/.test(location)
  // 我的 › … pages bring a back bar too, but keep the tab bar (settings tab)
  const subPage = /\/console\/me\/[^/]+$/.test(location)
  // a session chat runs closer to the edges (bubbles, like a messenger)
  const chat = /\/console\/sessions\/[^/]+$/.test(location)
  return (
    <main
      data-deck
      // fixed inset-0, not h-dvh: after an update reload Chrome's installed
      // app kept a stale, 56 px taller 100dvh for the shell (770 vs a 714 px
      // viewport, measured by host diagnostics) and the bottom tab bar sat
      // below the screen until restart. The fixed box follows the real layout
      // viewport, keyboard included (interactive-widget=resizes-content).
      className="fixed inset-0 grid grid-rows-[minmax(0,1fr)_auto] overflow-hidden bg-brand-deck text-brand-text md:grid-rows-[auto_minmax(0,1fr)]"
    >
      {/* top: status band (wide, local) / remote band (wide) / phone top bar */}
      {/* one fixed height whatever fills it, so the swap never shifts the page */}
      <div className="vt-band hidden h-9 overflow-hidden border-b border-brand-border bg-brand-surface md:block">
        {mode === 'local' ? (
          <StatusBand />
        ) : mode === 'remote' ? (
          <RemoteBand />
        ) : null}
      </div>
      <div className="grid min-h-0 md:grid-cols-[calc(var(--spacing)*52)_minmax(0,1fr)]">
        <aside className="vt-sidebar hidden min-h-0 flex-col overflow-hidden border-r border-brand-edge bg-brand-deck md:flex">
          {/* the brand is the way home (the landing page); language and
              theme live in 我的 › 外观, not in a second set of buttons here */}
          <Link
            to="/{-$locale}"
            params={{ locale: localeParam }}
            className="m-1.5 flex items-center gap-2 rounded-xl px-2 py-2 outline-none hover:bg-brand-soft focus-visible:ring-2 focus-visible:ring-brand-running"
          >
            <img src="/brand-icon.svg" alt="" width="28" height="28" />
            <div>
              <p className="text-body font-semibold">{t`WezDeck`}</p>
              <p className="text-meta text-brand-muted">
                {mode === 'local'
                  ? t`This computer`
                  : mode === 'remote'
                    ? t`Remote`
                    : ''}
              </p>
            </div>
          </Link>
          <nav
            className="grid min-h-0 content-start gap-1.5 overflow-y-auto px-2.5 py-1"
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
                  onClick={(event) => {
                    // a modified click still opens a new tab / window
                    if (
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.button !== 0
                    )
                      return
                    event.preventDefault()
                    if (!active) go(item.id)
                    // clicking 会话 while on it: re-read the held order
                    else if (item.id === 'sessions') {
                      resetSessionOrder()
                      void client.invalidateQueries({ queryKey: ['remote'] })
                    }
                  }}
                  className={cn(
                    'flex min-h-9 items-center gap-2.5 rounded-xl px-3 text-body outline-none focus-visible:ring-2 focus-visible:ring-brand-running',
                    active
                      ? 'bg-brand-surface font-semibold text-brand-text'
                      : 'text-brand-muted hover:bg-brand-soft',
                  )}
                >
                  <span>{item.icon}</span>
                  <span className="flex-1">{item.label}</span>
                  {badges[item.id] ? (
                    <CountBadge value={badges[item.id]!} />
                  ) : jump ? (
                    <kbd className="text-meta text-brand-label">g {jump}</kbd>
                  ) : null}
                </Link>
              )
            })}
          </nav>
          <KeysEntry />
        </aside>
        <div
          ref={scroller}
          // a size container: the split pages size their list and pane in
          // cqh, this column's real height — 100dvh could run taller in the
          // installed app (see the shell's fixed inset-0 note) and cut the
          // list's foot. Fixed overlays are portalled, so the containing
          // block this makes for them does not matter.
          // its own background: the transition snapshot of this column must be
          // opaque, or the page underneath shows through mid-push
          className="vt-page min-h-0 min-w-0 overflow-y-auto overscroll-contain bg-brand-deck [container-type:size]"
        >
          <a
            href="#console-main"
            className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-40 focus:bg-brand-surface focus:px-3 focus:py-2 focus:text-body focus:ring-2 focus:ring-brand-running"
          >
            {t`Skip to content`}
          </a>
          <div
            id="console-main"
            className={cn(
              'flex min-h-full flex-col pt-[max(env(safe-area-inset-top),0.75rem)] pb-4 md:pt-4',
              chat ? 'px-2.5 [--page-x:0.625rem]' : 'px-4 [--page-x:1rem]',
            )}
          >
            {detail || subPage ? null : (
              <div className="mb-3 flex items-center justify-between gap-3 pt-2 md:hidden">
                <h1 className="min-w-0 truncate text-display leading-tight font-semibold tracking-tight">
                  {title ?? t`WezDeck`}
                </h1>
                <Link
                  to="/{-$locale}/console/me/$page"
                  params={{ locale: localeParam, page: 'connection' }}
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
          'tabbar-vt grid grid-cols-3 border-t border-brand-edge bg-[var(--bar-bg)] pt-1.5 pb-[max(env(safe-area-inset-bottom),0.5rem)] backdrop-blur md:hidden',
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
                event.preventDefault()
                // a pushed page of this tab (我的 › 连接): back to its index
                if (!active || subPage) {
                  go(item.id)
                  return
                }
                // Re-tap the current tab: back to top + refresh (no pull-to-refresh);
                // on 会话 that re-reads the held order too (session-stable.ts)
                if (item.id === 'sessions') resetSessionOrder()
                scroller.current?.scrollTo({ top: 0, behavior: 'smooth' })
                void client.invalidateQueries({
                  queryKey: ['runtime', 'collab'],
                })
                void client.invalidateQueries({ queryKey: ['remote'] })
              }}
              className={cn(
                'relative flex min-h-12 flex-col items-center justify-center gap-0.5 text-meta',
                active ? 'font-semibold text-brand-text' : 'text-brand-label',
              )}
            >
              <span className="[&>svg]:size-6">{item.icon}</span>
              <span>{item.label}</span>
              {badges[item.id] ? (
                <span className="absolute top-0.5 left-[calc(50%+4px)]">
                  <CountBadge value={badges[item.id]!} />
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
    <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-brand-waiting px-1.5 text-meta leading-5 font-semibold text-[#1b1406]">
      {value > 99 ? '99+' : value}
    </span>
  )
}

function RemoteBand() {
  const { t } = useLingui()
  return (
    <div className="flex h-full flex-nowrap items-center gap-x-4 overflow-hidden px-4 text-meta whitespace-nowrap">
      <span className="text-brand-label">{t`Remote access`}</span>
      <RemoteBadge />
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

function StatusBand() {
  const { t } = useLingui()
  const { data, connected, loading } = useRuntimeData()
  return (
    <div className="flex h-full flex-nowrap items-center gap-x-5 overflow-hidden px-4 text-meta whitespace-nowrap">
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
      <p className="text-body text-brand-text">{t`This page hit a rendering error. The rest of the console is still available.`}</p>
      <p className="font-mono text-meta break-all text-brand-muted">
        {message}
      </p>
      <Button size="sm" variant="warning" onClick={onRetry}>
        {t`Retry`}
      </Button>
    </div>
  )
}
