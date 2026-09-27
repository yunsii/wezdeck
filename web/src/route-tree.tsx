import { createRoute, notFound, Outlet } from '@tanstack/react-router'

import { LandingPage } from '#/features/landing-page'
import { ConsoleDiagnosticsPage } from '#/features/console-diagnostics'
import { ConsoleDevelopmentPage } from '#/features/console-development'
import { ConsoleOverviewPage } from '#/features/console-overview'
import { ConsoleRouteLayout } from '#/features/console-shell'
import { Route as rootRoute } from '#/routes/__root'

export const locales = ['en', 'zh'] as const
export type AppLocale = (typeof locales)[number]

const siteUrl = (
  import.meta.env.VITE_SITE_URL ??
  (import.meta.env.DEV ? 'http://localhost:3000' : 'https://wezdeck.vercel.app')
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

const consoleOverviewRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: '/',
  component: ConsoleOverviewPage,
  head: ({ params }) =>
    consoleHead(
      params.locale === 'zh'
        ? 'WezDeck 运行时控制台'
        : 'WezDeck Runtime Console',
    ),
})

const consoleDevelopmentRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: 'development',
  component: ConsoleDevelopmentPage,
  head: ({ params }) =>
    consoleHead(
      params.locale === 'zh'
        ? 'WezDeck 开发控制台'
        : 'WezDeck Development Console',
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

export const routeTree = rootRoute.addChildren({
  localeRoute: localeRoute.addChildren({
    landingRoute,
    consoleRoute: consoleRoute.addChildren({
      consoleOverviewRoute,
      consoleDevelopmentRoute,
      consoleDiagnosticsRoute,
    }),
  }),
})
