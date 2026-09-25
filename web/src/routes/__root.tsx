import {
  HeadContent,
  ScriptOnce,
  Scripts,
  createRootRoute,
  useLocation,
} from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'

import appCss from '../styles.css?url'
import { AppI18nProvider } from '#/lib/i18n'
import { QueryProvider } from '#/lib/query-provider'
import { themeBootstrapScript, ThemeProvider } from '#/lib/theme-provider'

const fontBootstrapStyle = `
html {
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
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
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: 'WezDeck Runtime Console',
      },
    ],
    links: [
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
  const location = useLocation()
  const language =
    location.pathname === '/zh' || location.pathname.startsWith('/zh/')
      ? 'zh-CN'
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
            <QueryProvider>{children}</QueryProvider>
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
