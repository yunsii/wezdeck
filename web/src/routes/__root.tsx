import {
  HeadContent,
  ScriptOnce,
  Scripts,
  createRootRoute,
  useParams,
} from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'

import appCss from '../styles.css?url'
import { AppI18nProvider } from '#/lib/i18n'
import { locales } from '#/route-tree'
import { QueryProvider } from '#/lib/query-provider'
import { PwaBoot } from '#/features/pwa-boot'
import { themeBootstrapScript, ThemeProvider } from '#/lib/theme-provider'

const fontBootstrapStyle = `
html {
  font-family: "Inter Variable", "Noto Sans SC Variable", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  font-synthesis: none;
}
body {
  margin: 0;
  font-family: inherit;
}
`

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        // viewport-fit=cover: the installed app draws under the notch /
        // home indicator; layouts pad with env(safe-area-inset-*).
        // interactive-widget: the on-screen keyboard shrinks the layout (Android
        // Chrome otherwise only shrinks the visual viewport and covers the
        // bottom composer until typing starts).
        content:
          'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content',
      },
      {
        title: 'WezDeck Runtime Console',
      },
      {
        name: 'theme-color',
        content: '#e6ebf1',
        media: '(prefers-color-scheme: light)',
      },
      {
        name: 'theme-color',
        content: '#141b26',
        media: '(prefers-color-scheme: dark)',
      },
      { name: 'apple-mobile-web-app-capable', content: 'yes' },
      { name: 'mobile-web-app-capable', content: 'yes' },
      { name: 'apple-mobile-web-app-title', content: 'WezDeck' },
      {
        name: 'apple-mobile-web-app-status-bar-style',
        content: 'black-translucent',
      },
    ],
    links: [
      { rel: 'manifest', href: '/manifest.webmanifest' },
      { rel: 'apple-touch-icon', href: '/icons/apple-touch-icon.png' },
      {
        rel: 'stylesheet',
        href: appCss,
      },
      {
        rel: 'icon',
        href: '/brand-favicon.svg',
        type: 'image/svg+xml',
      },
    ],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  const { locale } = useParams({ strict: false })
  const language = locales.includes(locale as (typeof locales)[number])
    ? locale === 'zh'
      ? 'zh-CN'
      : locale
    : 'en'
  return (
    <html lang={language} suppressHydrationWarning>
      <head>
        <style dangerouslySetInnerHTML={{ __html: fontBootstrapStyle }} />
        <ScriptOnce>{themeBootstrapScript}</ScriptOnce>
        <HeadContent />
      </head>
      <body>
        <ThemeProvider>
          <AppI18nProvider>
            <QueryProvider>
              {children}
              <PwaBoot />
            </QueryProvider>
          </AppI18nProvider>
        </ThemeProvider>
        {import.meta.env.DEV ? (
          <TanStackDevtools
            config={{ position: 'bottom-right' }}
            plugins={[
              {
                name: 'Tanstack Router',
                render: <TanStackRouterDevtoolsPanel />,
              },
            ]}
          />
        ) : null}
        <Scripts />
      </body>
    </html>
  )
}
