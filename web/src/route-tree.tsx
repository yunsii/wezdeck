import { createRoute, notFound, Outlet, redirect } from '@tanstack/react-router'

import { LandingPage } from '#/features/landing-page'
import { ArchitecturePage } from '#/features/architecture/architecture-page'
import { ConsoleCollabPage } from '#/features/console-collab'
import { ConsoleInboxPage } from '#/features/tickets-view'
import { ConsoleActivityPage } from '#/features/console-activity'
import { ConsoleMePage } from '#/features/console-me'
import { ConsoleSessionsPage } from '#/features/session-split'
import { ConsoleDiagnosticsPage } from '#/features/console-diagnostics'
import { ConsoleInteractionsPage } from '#/features/console-interactions'
import { ConsoleRouteLayout } from '#/features/console-shell'
import { Route as rootRoute } from '#/routes/__root'

export const locales = ['en', 'zh'] as const
export type AppLocale = (typeof locales)[number]

const siteUrl = (
  import.meta.env.VITE_SITE_URL ??
  (import.meta.env.DEV ? 'http://localhost:3000' : 'https://wezdeck.yuns.love')
).replace(/\/$/, '')

function marketingHead({
  locale,
  title,
  description,
  path,
}: {
  locale: 'en' | 'zh'
  title: string
  description: string
  path: string
}) {
  const localizedPath =
    locale === 'zh' ? `/zh${path === '/' ? '' : path}` : path
  const url = `${siteUrl}${localizedPath}`
  const englishUrl = `${siteUrl}${path}`
  const chineseUrl = `${siteUrl}/zh${path === '/' ? '' : path}`
  return {
    meta: [
      { title },
      { name: 'description', content: description },
      { name: 'robots', content: 'index,follow' },
      { property: 'og:type', content: 'website' },
      { property: 'og:site_name', content: 'WezDeck' },
      { property: 'og:locale', content: locale === 'zh' ? 'zh_CN' : 'en_US' },
      { property: 'og:title', content: title },
      { property: 'og:description', content: description },
      { property: 'og:url', content: url },
      { property: 'og:image', content: `${siteUrl}/brand-icon.svg` },
      { name: 'twitter:card', content: 'summary' },
      { name: 'twitter:image', content: `${siteUrl}/brand-icon.svg` },
      { name: 'twitter:url', content: url },
      { name: 'twitter:title', content: title },
      { name: 'twitter:description', content: description },
    ],
    links: [
      { rel: 'canonical', href: url },
      { rel: 'alternate', hrefLang: 'en', href: englishUrl },
      { rel: 'alternate', hrefLang: 'zh-CN', href: chineseUrl },
      { rel: 'alternate', hrefLang: 'x-default', href: englishUrl },
    ],
  }
}

const localeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/{-$locale}',
  params: {
    parse: ({ locale }) => {
      if (locale !== undefined && !locales.includes(locale as AppLocale)) {
        throw notFound()
      }
      return { locale: locale as AppLocale | undefined }
    },
  },
  component: () => <Outlet />,
})

const landingRoute = createRoute({
  getParentRoute: () => localeRoute,
  path: '/',
  component: LandingPage,
  head: ({ params }) =>
    marketingHead({
      locale: params.locale ?? 'en',
      title:
        params.locale === 'zh'
          ? 'WezDeck：本地优先的 AI Agent 工作台'
          : 'WezDeck: A local-first control plane for AI coding agents',
      description:
        params.locale === 'zh'
          ? 'WezDeck 是本地优先的 AI Agent 工作台，构建于 WezTerm、tmux 和 git worktree 之上。'
          : 'WezDeck is a local-first control plane for AI coding agents, built on WezTerm, tmux, and git worktrees.',
      path: '/',
    }),
})

const architectureRoute = createRoute({
  getParentRoute: () => localeRoute,
  path: 'architecture',
  component: ArchitecturePage,
  head: ({ params }) =>
    marketingHead({
      locale: params.locale ?? 'en',
      title:
        params.locale === 'zh'
          ? 'WezDeck 架构解析：会话、工单与本地服务'
          : 'WezDeck architecture: sessions, tickets and local services',
      description:
        params.locale === 'zh'
          ? 'WezDeck 的整体架构、手机打开会话与发消息的流程、工单生命周期，以及本地 Runtime、relay、bridge 提供的全部能力。'
          : 'How WezDeck fits together: opening and writing to sessions from a phone, the ticket lifecycle, and everything the local Runtime, relay and bridge offer.',
      path: '/architecture',
    }),
})

const consoleRoute = createRoute({
  getParentRoute: () => localeRoute,
  path: 'console',
  component: ConsoleRouteLayout,
})

function consoleHead(title: string) {
  return {
    meta: [{ title }, { name: 'robots', content: 'noindex,nofollow' }],
  }
}

// 总览 is gone (its Runtime / IME / WSL facts are 我的 › 本机): the console
// index opens 会话 on every device, like the phone always did
const consoleOverviewRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: '/',
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/{-$locale}/console/sessions',
      params: { locale: params.locale },
      replace: true,
    })
  },
})

// 开发 is gone: 会话's repo → worktree tree covers it, and 打开 VS Code moved
// into 会话信息 (local mode). Old links / `g d` habits land on 会话.
const consoleDevelopmentRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: 'development',
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/{-$locale}/console/sessions',
      params: { locale: params.locale },
      replace: true,
    })
  },
})

const consoleInteractionsRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: 'interactions',
  component: ConsoleInteractionsPage,
  head: ({ params }) =>
    consoleHead(
      params.locale === 'zh' ? 'WezDeck 交互调试' : 'WezDeck Interactions',
    ),
})

const consoleDiagnosticsRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: 'diagnostics',
  component: ConsoleDiagnosticsPage,
  head: ({ params }) =>
    consoleHead(
      params.locale === 'zh' ? 'WezDeck 诊断' : 'WezDeck Diagnostics',
    ),
})

const consoleCollabRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: 'collab',
  component: ConsoleCollabPage,
  head: ({ params }) =>
    consoleHead(params.locale === 'zh' ? 'WezDeck 跨仓协作' : 'WezDeck Collab'),
})

const collabTitle = (locale: string | undefined, zh: string, en: string) =>
  consoleHead(locale === 'zh' ? `WezDeck ${zh}` : `WezDeck ${en}`)

const consoleCollabTicketRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: 'collab/$id',
  component: ConsoleCollabPage,
  head: ({ params }) => collabTitle(params.locale, '工单', 'Ticket'),
})

const consoleInboxRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: 'inbox',
  component: ConsoleInboxPage,
  head: ({ params }) => collabTitle(params.locale, '待处理', 'Inbox'),
})

const consoleInboxTicketRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: 'inbox/$id',
  component: ConsoleInboxPage,
  head: ({ params }) => collabTitle(params.locale, '待处理', 'Inbox'),
})

const consoleActivityRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: 'activity',
  component: ConsoleActivityPage,
  head: ({ params }) => collabTitle(params.locale, '动态', 'Activity'),
})

const consoleMeRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: 'me',
  component: ConsoleMePage,
  head: ({ params }) => collabTitle(params.locale, '我的', 'Settings'),
})

// 现在 is gone (会话 is the home, waiting items badge their own tab); the
// route stays as a redirect: installed apps still start at /console/now
// until Chrome refreshes their manifest
const consoleMePageRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: 'me/$page',
  component: ConsoleMePage,
  head: ({ params }) => collabTitle(params.locale, '我的', 'Settings'),
})

const consoleNowRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: 'now',
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/{-$locale}/console/sessions',
      params: { locale: params.locale },
      replace: true,
    })
  },
})

const consoleSessionsRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: 'sessions',
  component: ConsoleSessionsPage,
  head: ({ params }) => collabTitle(params.locale, '会话', 'Sessions'),
})

const consoleSessionRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: 'sessions/$id',
  component: ConsoleSessionsPage,
  head: ({ params }) => collabTitle(params.locale, '会话', 'Session'),
})

export const routeTree = rootRoute.addChildren({
  localeRoute: localeRoute.addChildren({
    landingRoute,
    architectureRoute,
    consoleRoute: consoleRoute.addChildren({
      consoleOverviewRoute,
      consoleDevelopmentRoute,
      consoleDiagnosticsRoute,
      consoleInteractionsRoute,
      consoleCollabRoute,
      consoleCollabTicketRoute,
      consoleInboxRoute,
      consoleInboxTicketRoute,
      consoleActivityRoute,
      consoleMeRoute,
      consoleMePageRoute,
      consoleNowRoute,
      consoleSessionsRoute,
      consoleSessionRoute,
    }),
  }),
})
