import { useLingui } from '@lingui/react/macro'
import {
  Activity,
  GitPullRequestArrow,
  ListTree,
  MessagesSquare,
  UserRound,
} from 'lucide-react'
import {
  Component,
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
} from 'react'
import type { ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, Outlet, useRouter, useRouterState } from '@tanstack/react-router'

import { Button } from '#/components/ui/button'
import { OverlayScroll } from '#/components/deck/overlay-scroll'
import { useTicketList, useTicketSync } from '#/lib/ticket-sync'
import { useGoToTab } from '#/lib/go-to-tab'
import { cn } from '#/lib/utils'
import { useLocale } from '#/lib/locale-context'
import { RuntimeDataProvider } from './console-data'
import { StatusBand } from './console-status-band'
import { resetSessionOrder } from './session-stable'
import { useLayoutMode } from './console-mode'
import { JUMP_KEYS, useJumpKeys } from './console-jump-keys'
import { KeysEntry } from './console-keys'
import { useSessions } from './console-sessions'
import { useAutoSyncAttentionSessions } from './session-autosync'
import { unreadChatCount } from './session-chats'
import { useFollowSessionRedirect } from './session-follow'
import { useAutoSyncTickets } from './ticket-autosync'
import { installClientTrace } from '#/lib/client-trace'
import { remoteLink } from '#/lib/remote-link'
import { useSessionListScroll } from './session-list-scroll'

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
    footer?: boolean
  }> = [
    {
      id: 'sessions',
      label: t({ message: 'Sessions', context: 'nav' }),
      icon: <MessagesSquare size={20} aria-hidden />,
    },
    {
      id: 'collab',
      label: t`Tickets`,
      icon: <GitPullRequestArrow size={20} aria-hidden />,
    },
    {
      id: 'activity',
      label: t`Ticket activity`,
      icon: <ListTree size={20} aria-hidden />,
    },
    {
      id: 'diagnostics',
      label: t`Diagnostics`,
      icon: <Activity size={20} aria-hidden />,
      local: true,
      footer: true,
    },
    {
      id: 'me',
      label: t`Settings`,
      icon: <UserRound size={20} aria-hidden />,
      footer: true,
    },
  ]
  // Desktop narrow Telegram-style rail mirrors mobile IA: 会话 / 工单 on top,
  // 诊断 (local) / 我的 anchored at the bottom. 工单动态 lives in the Tickets
  // top bar on both phone and desktop (g a still jumps straight to it).
  const rail = all.filter(
    (item) => item.id !== 'activity' && (mode === 'local' || !item.local),
  )
  return {
    mode,
    all,
    railPrimary: rail.filter((item) => !item.footer),
    railFooter: rail.filter((item) => item.footer),
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

function useRemoteMode() {
  return useSyncExternalStore(
    remoteLink.subscribe,
    () => remoteLink.snapshot().mode,
    () => 'unpaired' as const,
  )
}

function useShellAutoSync(location: string) {
  const health = useTicketSync()
  const ticketList = useTicketList()
  const sessions = useSessions()
  const activeSessionRaw = location.match(/\/console\/sessions\/([^/]+)$/)?.[1]
  useAutoSyncAttentionSessions(
    sessions.data?.sessions,
    activeSessionRaw ? decodeURIComponent(activeSessionRaw) : undefined,
  )
  const activeTicketRaw = location.match(
    /\/console\/(?:collab|inbox)\/([^/]+)$/,
  )?.[1]
  useAutoSyncTickets(
    ticketList.data?.ok ? ticketList.data.tickets : undefined,
    activeTicketRaw ? decodeURIComponent(activeTicketRaw) : undefined,
  )
  useFollowSessionRedirect()
  return { health, sessions }
}

type RailItem = {
  id: Section
  label: string
  icon: ReactNode
  local?: boolean
  footer?: boolean
}

function RailLink({
  item,
  current,
  localeParam,
  badge,
  onSelect,
}: {
  item: RailItem
  current: Section
  localeParam: 'zh' | undefined
  badge?: number
  onSelect: (item: RailItem, active: boolean) => void
}) {
  const active =
    current === item.id ||
    (item.id === 'collab' && (current === 'activity' || current === 'inbox'))
  const jump = Object.entries(JUMP_KEYS).find(
    ([, section]) => section === item.id,
  )?.[0]
  return (
    <Link
      to={SECTION_PATH[item.id]}
      params={{ locale: localeParam }}
      aria-current={active ? 'page' : undefined}
      title={jump ? `${item.label} (g ${jump})` : item.label}
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
        onSelect(item, active)
      }}
      className={cn(
        'relative flex min-h-13 w-full min-w-0 flex-col items-center justify-center gap-0.5 rounded-xl px-0.5 py-1.5 text-center transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand-running',
        active
          ? 'bg-brand-running/12 font-semibold text-brand-running'
          : 'text-brand-muted hover:bg-brand-soft hover:text-brand-text',
      )}
    >
      <span className="shrink-0">{item.icon}</span>
      <span className="max-w-full truncate text-meta leading-tight">
        {item.label}
      </span>
      {badge ? (
        <span className="absolute top-0.5 right-1">
          <CountBadge value={badge} />
        </span>
      ) : null}
    </Link>
  )
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
  const { mode, all, railPrimary, railFooter, tabs } = useSections()
  const { health, sessions } = useShellAutoSync(location)
  // ticket / session detail pages bring their own back bar instead of a title
  const detail = /\/console\/(collab|inbox|sessions)\/[^/]+$/.test(location)
  // 我的 › … pages bring a back bar too, but keep the tab bar (settings tab)
  const subPage = /\/console\/me\/[^/]+$/.test(location)
  // a session chat runs closer to the edges (bubbles, like a messenger)
  const chat = /\/console\/sessions\/[^/]+$/.test(location)
  // ticket detail pins its own sticky header flush against the top edge
  const ticketDetail = /\/console\/(collab|inbox)\/[^/]+$/.test(location)
  // Every index / list view shares the Telegram-style full-bleed surface + compact sticky bar
  const flatIndex = !detail && !subPage
  const badges: Partial<Record<Section, number>> = {
    collab: health.data?.waiting_human ?? 0,
    sessions: unreadChatCount(sessions.data?.sessions ?? []),
  }
  const scroller = useRef<HTMLDivElement>(null)
  useSessionListScroll(scroller)
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
    all
      .filter((item) => mode === 'local' || !item.local)
      .map((item) => item.id),
    localeParam,
  )
  const title = all.find((item) => item.id === current)?.label
  const remoteMode = useRemoteMode()
  // Start the remote link (adopts a #pair= token) on every console page, not
  // only when a collab read happens: settings and sessions need it too.
  useEffect(() => {
    installClientTrace()
    return remoteLink.start()
  }, [])
  const onRailSelect = useCallback(
    (item: RailItem, active: boolean) => {
      if (!active) go(item.id)
      // clicking 会话 while on it: re-read the held order
      else if (item.id === 'sessions') {
        resetSessionOrder()
        void client.invalidateQueries({ queryKey: ['remote'] })
      } else if (item.id === 'collab' && current !== 'collab') {
        go('collab')
      }
    },
    [client, current, go],
  )
  return (
    <main
      data-deck
      data-remote-mode={remoteMode === 'unpaired' ? undefined : remoteMode}
      // fixed inset-0, not h-dvh: after an update reload Chrome's installed
      // app kept a stale, 56 px taller 100dvh for the shell (770 vs a 714 px
      // viewport, measured by host diagnostics) and the bottom tab bar sat
      // below the screen until restart. The fixed box follows the real layout
      // viewport, keyboard included (interactive-widget=resizes-content).
      className="fixed inset-0 grid grid-rows-[minmax(0,1fr)_auto] overflow-hidden bg-brand-deck text-brand-text"
    >
      <div className="grid min-h-0 md:grid-cols-[calc(var(--spacing)*18)_minmax(0,1fr)] md:items-stretch">
        <aside className="vt-sidebar hidden min-h-0 flex-col items-stretch overflow-hidden border-r border-brand-edge bg-brand-deck px-1 py-2 md:flex">
          {/* the brand is the way home (the landing page); language and
              theme live in 我的 › 外观, not in a second set of buttons here */}
          <Link
            to="/{-$locale}"
            params={{ locale: localeParam }}
            aria-label={t`WezDeck`}
            title={
              mode === 'local'
                ? `${t`WezDeck`} · ${t`This computer`}`
                : mode === 'remote'
                  ? `${t`WezDeck`} · ${t`Remote`}`
                  : t`WezDeck`
            }
            className="mb-2 flex size-11 shrink-0 items-center justify-center self-center rounded-xl outline-none transition-colors hover:bg-brand-soft focus-visible:ring-2 focus-visible:ring-brand-running"
          >
            <img src="/brand-icon.svg" alt="" width="28" height="28" />
          </Link>
          <nav
            className="flex min-h-0 flex-1 flex-col"
            aria-label={t`Console navigation`}
          >
            <OverlayScroll>
              <div className="grid grid-cols-1 content-start gap-1">
                {railPrimary.map((item) => (
                  <RailLink
                    key={item.id}
                    item={item}
                    current={current}
                    localeParam={localeParam}
                    badge={badges[item.id]}
                    onSelect={onRailSelect}
                  />
                ))}
              </div>
            </OverlayScroll>
            <div className="mt-auto grid shrink-0 grid-cols-1 gap-1 border-t border-brand-edge pt-2">
              {railFooter.map((item) => (
                <RailLink
                  key={item.id}
                  item={item}
                  current={current}
                  localeParam={localeParam}
                  badge={badges[item.id]}
                  onSelect={onRailSelect}
                />
              ))}
              <KeysEntry />
            </div>
          </nav>
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
              'flex min-h-full w-full flex-col md:min-h-full md:p-0',
              flatIndex
                ? 'p-0 [--page-x:0.75rem] md:[--page-x:0.75rem]'
                : ticketDetail
                  ? 'px-3 pt-0 pb-4 [--page-x:0.75rem] md:[--page-x:1rem]'
                  : 'pt-[max(env(safe-area-inset-top),0.75rem)] pb-4',
              !flatIndex &&
                !ticketDetail &&
                (chat ? 'px-2.5 [--page-x:0.625rem]' : 'px-4 [--page-x:1rem]'),
            )}
          >
            {detail || subPage || flatIndex ? null : (
              <MobileSectionHeader title={title} />
            )}
            <PageBoundary>{children}</PageBoundary>
          </div>
        </div>
      </div>
      {/* bottom: mobile tab bar (<768px) or slim 32px diagnostics strip (≥768px) */}
      {mode === 'local' ? (
        <div className="vt-band hidden h-8 overflow-hidden border-t border-brand-edge bg-brand-deck md:block">
          <StatusBand />
        </div>
      ) : null}
      <nav
        aria-label={t`Sections`}
        className={cn(
          'tabbar-vt grid grid-cols-3 border-t border-brand-edge bg-[var(--bar-bg)] pt-1.5 pb-[max(env(safe-area-inset-bottom),0.5rem)] backdrop-blur md:hidden',
          // detail pages are full screen (like a chat): back bar on top, no tabs
          detail && 'hidden',
        )}
      >
        {tabs.map((item) => {
          const active =
            current === item.id ||
            (item.id === 'collab' &&
              (current === 'activity' || current === 'inbox')) ||
            (item.id === 'me' && current === 'diagnostics')
          return (
            <Link
              key={item.id}
              to={SECTION_PATH[item.id]}
              params={{ locale: localeParam }}
              replace
              aria-current={active ? 'page' : undefined}
              onClick={(event) => {
                event.preventDefault()
                // a pushed page of this tab (我的 › 连接, 工单 › 动态): back to its index
                if (!active || subPage || current !== item.id) {
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
                'relative flex min-h-12 flex-col items-center justify-center gap-0.5 text-meta transition-colors',
                active
                  ? 'font-semibold text-brand-running'
                  : 'text-brand-label',
              )}
            >
              <span className="[&>svg]:size-5.5">{item.icon}</span>
              <span>{item.label}</span>
              {badges[item.id] ? (
                <span className="absolute top-0.5 left-[calc(50%+6px)]">
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

function MobileSectionHeader({ title }: { title?: string }) {
  const { t } = useLingui()
  return (
    <div className="mb-3 flex items-center justify-between gap-3 pt-2 md:hidden">
      <h1 className="min-w-0 truncate text-display leading-tight font-semibold tracking-tight">
        {title ?? t`WezDeck`}
      </h1>
    </div>
  )
}

function CountBadge({ value }: { value: number }) {
  return (
    <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-brand-waiting px-1.5 text-meta leading-5 font-semibold text-[#1b1406]">
      {value > 99 ? '99+' : value}
    </span>
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
