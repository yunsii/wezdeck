import { createContext, useContext } from 'react'

import type { AppLocale } from '#/route-tree'

export type Locale = AppLocale

export const LocaleContext = createContext<{ locale: Locale } | null>(null)

export function useLocale() {
  const context = useContext(LocaleContext)
  if (!context) throw new Error('useLocale must be used within AppI18nProvider')
  return context
}
