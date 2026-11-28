// Shared sticky header for public pages (/ and /architecture): fixed 56 px
// height (so sticky sub-bars sit cleanly at top-14), brand mark, optional
// in-app back button (when opened from 我的 › 架构解析 in the installed PWA),
// site-level links, language/theme click menus, and a responsive console CTA.
import { useLingui } from '@lingui/react/macro'
import { Link } from '@tanstack/react-router'
import { ArrowRight, GitBranch } from 'lucide-react'

import { BackButton } from '#/components/deck/back-button'
import { useLocale } from '#/lib/locale-context'
import { useTheme } from '#/lib/theme-provider'
import { cn } from '#/lib/utils'
import { LanguageSwitcher, ThemeSwitcher } from './console-shared'

export const SOURCE_URL = 'https://github.com/yunsii/wezdeck'

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
    <header className="sticky top-0 z-30 h-14 border-b border-brand-edge bg-brand-deck/92 backdrop-blur">
      <div
        className={cn(
          'mx-auto flex h-full items-center justify-between gap-2 px-3 sm:gap-3 sm:px-5',
          maxWidth,
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden sm:gap-1">
          {onBack ? (
            <BackButton
              onClick={onBack}
              label={t`Back`}
              className="-ml-2 shrink-0"
            />
          ) : null}
          <Link
            to="/{-$locale}"
            params={{ locale: localeParam }}
            data-testid="public-brand"
            className="inline-flex min-w-0 items-center gap-2 rounded-xl px-1 py-1 text-title font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-brand-running sm:px-1.5"
          >
            <img
              src="/brand-icon.svg"
              alt=""
              width="26"
              height="26"
              className="shrink-0"
            />
            <span className="truncate">WezDeck</span>
          </Link>
          <nav
            aria-label={t`Site navigation`}
            className="ml-2 hidden shrink-0 items-center gap-1 sm:flex"
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
        <div
          data-testid="public-header-actions"
          className="flex shrink-0 items-center gap-1 sm:gap-1.5"
        >
          <LanguageSwitcher locale={locale} />
          <ThemeSwitcher mode={mode} onChange={setMode} />
          {/* when opened from inside the console (onBack), phone already has ‹ Back */}
          <Link
            to="/{-$locale}/console"
            params={{ locale: localeParam }}
            className={cn(
              'key-press ml-0.5 inline-flex min-h-9 items-center gap-1 rounded-xl bg-brand-text px-2.5 text-caption font-semibold text-brand-deck outline-none focus-visible:ring-2 focus-visible:ring-brand-running focus-visible:ring-offset-2 focus-visible:ring-offset-brand-deck sm:ml-1 sm:gap-1.5 sm:px-3.5',
              onBack && 'hidden sm:inline-flex',
            )}
          >
            <span className="sm:hidden">{t`Console`}</span>
            <span className="hidden sm:inline">{t`Open the console`}</span>
            <ArrowRight size={14} aria-hidden className="shrink-0" />
          </Link>
        </div>
      </div>
    </header>
  )
}
