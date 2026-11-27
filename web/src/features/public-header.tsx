// Shared sticky header for public pages (/ and /architecture): brand mark,
// optional in-app back button (when opened from 我的 › 架构解析 in the installed
// PWA), site-level links, language/theme click menus, and a compact console CTA.
import { useLingui } from '@lingui/react/macro'
import { Link } from '@tanstack/react-router'
import { ArrowRight, GitBranch } from 'lucide-react'

import { BackButton } from '#/components/deck/back-button'
import { useLocale } from '#/lib/locale-context'
import { useTheme } from '#/lib/theme-provider'
import { cn } from '#/lib/utils'
import { LanguageSwitcher, ThemeSwitcher } from './console-shared'

export const SOURCE_URL = 'https://github.com/yunsii/wezterm-config'

export function PublicHeader({
  active,
  maxWidth = 'max-w-5xl',
  onBack,
}: {
  active: 'landing' | 'architecture'
  maxWidth?: string
  /** present when opened from inside the installed console */
  onBack?: () => void
}) {
  const { t } = useLingui()
  const { locale } = useLocale()
  const { mode, setMode } = useTheme()
  const localeParam = locale === 'en' ? undefined : locale
  const navLink = (current: boolean) =>
    cn(
      'inline-flex min-h-9 items-center rounded-xl px-3 text-caption transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand-running',
      current
        ? 'bg-brand-soft font-semibold text-brand-text'
        : 'text-brand-muted hover:bg-brand-soft hover:text-brand-text',
    )
  return (
    <header className="sticky top-0 z-30 border-b border-brand-edge bg-brand-deck/92 backdrop-blur">
      <div
        className={cn(
          'mx-auto flex items-center justify-between gap-3 px-4 py-2.5 sm:px-5',
          maxWidth,
        )}
      >
        <div className="flex min-w-0 items-center gap-1">
          {onBack ? (
            <BackButton
              onClick={onBack}
              label={t`Back`}
              className="-ml-2.5 shrink-0"
            />
          ) : null}
          <Link
            to="/{-$locale}"
            params={{ locale: localeParam }}
            className="inline-flex shrink-0 items-center gap-2 rounded-xl px-1.5 py-1 text-title font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-brand-running"
          >
            <img src="/brand-icon.svg" alt="" width="26" height="26" />
            <span>WezDeck</span>
          </Link>
          <nav
            aria-label={t`Site navigation`}
            className="ml-2 hidden items-center gap-1 sm:flex"
          >
            <Link
              to="/{-$locale}"
              params={{ locale: localeParam }}
              aria-current={active === 'landing' ? 'page' : undefined}
              className={navLink(active === 'landing')}
            >
              {t`Overview`}
            </Link>
            <Link
              to="/{-$locale}/architecture"
              params={{ locale: localeParam }}
              aria-current={active === 'architecture' ? 'page' : undefined}
              className={navLink(active === 'architecture')}
            >
              {t`How it fits together`}
            </Link>
            <a
              href={SOURCE_URL}
              target="_blank"
              rel="noreferrer"
              className="hidden min-h-9 items-center gap-1.5 rounded-xl px-3 text-caption text-brand-muted transition-colors outline-none hover:bg-brand-soft hover:text-brand-text focus-visible:ring-2 focus-visible:ring-brand-running md:inline-flex"
            >
              <GitBranch size={14} aria-hidden />
              {t`Source`}
            </a>
          </nav>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <LanguageSwitcher locale={locale} />
          <ThemeSwitcher mode={mode} onChange={setMode} />
          <Link
            to="/{-$locale}/console"
            params={{ locale: localeParam }}
            className="key-press ml-1 inline-flex min-h-9 items-center gap-1.5 rounded-xl bg-brand-text px-3.5 text-caption font-semibold text-brand-deck outline-none focus-visible:ring-2 focus-visible:ring-brand-running focus-visible:ring-offset-2 focus-visible:ring-offset-brand-deck"
          >
            <span>{t`Open the console`}</span>
            <ArrowRight size={14} aria-hidden />
          </Link>
        </div>
      </div>
    </header>
  )
}
