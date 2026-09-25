import { createRoute, Outlet } from '@tanstack/react-router'

import { LandingPage } from '#/features/landing-page'
import { RuntimeConsole } from '#/features/runtime-console'
import { Route as rootRoute } from '#/routes/__root'

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

const landingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: LandingPage,
  head: () =>
    marketingHead({
      locale: 'en',
      title: 'WezDeck: A local-first AI Deck',
      description:
        'WezDeck is a local-first flight deck for AI agents, built on WezTerm, tmux, and git worktrees.',
      path: '/',
    }),
})

const consoleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'console',
  component: RuntimeConsole,
  head: () => ({
    meta: [
      { title: 'WezDeck Runtime Console' },
      { name: 'robots', content: 'noindex,nofollow' },
    ],
  }),
})

const zhRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'zh',
  component: () => <Outlet />,
})

const zhLandingRoute = createRoute({
  getParentRoute: () => zhRoute,
  path: '/',
  component: LandingPage,
  head: () =>
    marketingHead({
      locale: 'zh',
      title: 'WezDeck：本地优先的 AI Agent 工作台',
      description:
        'WezDeck 是本地优先的 AI Agent 工作台，构建于 WezTerm、tmux 和 git worktree 之上。',
      path: '/',
    }),
})

const zhConsoleRoute = createRoute({
  getParentRoute: () => zhRoute,
  path: 'console',
  component: RuntimeConsole,
  head: () => ({
    meta: [
      { title: 'WezDeck 运行时控制台' },
      { name: 'robots', content: 'noindex,nofollow' },
    ],
  }),
})

export const routeTree = rootRoute.addChildren({
  landingRoute,
  consoleRoute,
  zhRoute: zhRoute.addChildren({ zhLandingRoute, zhConsoleRoute }),
})
