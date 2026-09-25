import { createContext, useContext } from 'react'

export type Locale = string

export const LocaleContext = createContext<{ locale: Locale } | null>(null)

export function useLocale() {
  const context = useContext(LocaleContext)
  if (!context) throw new Error('useLocale must be used within AppI18nProvider')
  return context
}
