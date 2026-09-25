import { setupI18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { useLocation } from '@tanstack/react-router'
import { useEffect, useMemo } from 'react'

import { LocaleContext } from './locale-context'
import type { Locale } from './locale-context'

type CatalogModule = { messages: Record<string, string> }
const catalogModules = import.meta.glob<CatalogModule>(
  '../locales/*/messages.po',
  {
    eager: true,
  },
)

export function AppI18nProvider({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const locale: Locale =
    location.pathname === '/zh' || location.pathname.startsWith('/zh/')
      ? 'zh'
      : 'en'
  const localeI18n = useMemo(() => {
    const instance = setupI18n()
    for (const [path, catalog] of Object.entries(catalogModules)) {
      const catalogLocale = path.match(/locales\/([^/]+)\/messages\.po$/)?.[1]
      if (catalogLocale) instance.load(catalogLocale, catalog.messages)
    }
    instance.activate(locale)
    return instance
  }, [locale])

  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : locale
  }, [locale])

  return (
    <LocaleContext.Provider value={{ locale }}>
      <I18nProvider i18n={localeI18n}>{children}</I18nProvider>
    </LocaleContext.Provider>
  )
}
