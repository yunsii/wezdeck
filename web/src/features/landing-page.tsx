// The landing page, in the console's ink theme ([data-deck]): what WezDeck
// is in one line, one way in (the console) and the source, a still of the
// session list with the console's own status lights, and the three things it
// does — sessions, tickets, from anywhere. No marketing chrome: no eyebrow
// labels, no capital-letter captions, no second copy of the same CTA.
import { useLingui } from '@lingui/react/macro'
import { Link } from '@tanstack/react-router'
import { ArrowRight, GitBranch } from 'lucide-react'

import { Led } from '#/components/deck/led'
import type { LedTone } from '#/components/deck/led'
import { useLocale } from '#/lib/locale-context'
import { useTheme } from '#/lib/theme-provider'
import { LanguageSwitcher, ThemeSwitcher } from './console-shared'

const SOURCE = 'https://github.com/yunsii/wezterm-config'

export function LandingPage() {
  const { t } = useLingui()
  const { locale } = useLocale()
  const { mode, setMode } = useTheme()
  const localeParam = locale === 'en' ? undefined : locale
  const console_ = (
    <Link
      to="/{-$locale}/console"
      params={{ locale: localeParam }}
      className="key-press inline-flex min-h-11 items-center gap-2 rounded-[12px] bg-brand-text px-5 text-[15px] font-semibold text-brand-deck"
    >
      {t`Open the console`}
      <ArrowRight size={16} aria-hidden />
    </Link>
  )
  return (
    <main data-deck className="min-h-dvh bg-brand-deck text-brand-text">
      <header className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-4">
        <Link
          to="/{-$locale}"
          params={{ locale: localeParam }}
          className="inline-flex items-center gap-2.5 text-[16px] font-semibold"
        >
          <img src="/brand-icon.svg" alt="" width="28" height="28" />
          WezDeck
        </Link>
        <div className="flex items-center gap-2">
          <LanguageSwitcher locale={locale} />
          <ThemeSwitcher mode={mode} onChange={setMode} />
        </div>
      </header>

      <section className="mx-auto grid max-w-5xl items-center gap-10 px-5 pt-10 pb-16 md:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] md:pt-20">
        <div className="grid content-start gap-5">
          <h1 className="text-[44px] leading-none font-bold tracking-tight md:text-[64px]">
            WezDeck
          </h1>
          <p className="max-w-xl text-[17px] leading-relaxed text-brand-muted md:text-[19px]">
            {t`A local-first workbench for AI coding agents. Every session keeps its WezTerm tab, tmux pane and git worktree — and follows you to your phone.`}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            {console_}
            <a
              href={SOURCE}
              target="_blank"
              rel="noreferrer"
              className="key-press inline-flex min-h-11 items-center gap-2 rounded-[12px] border border-brand-edge bg-brand-surface px-4 text-[15px] font-medium"
            >
              <GitBranch size={16} aria-hidden />
              {t`View the source`}
            </a>
          </div>
        </div>
        <SessionStill />
      </section>

      <section className="border-t border-brand-edge bg-brand-surface">
        <div className="mx-auto grid max-w-5xl gap-8 px-5 py-14 md:grid-cols-3 md:gap-10">
          <Point
            title={t({ message: 'Sessions', context: 'nav' })}
            body={t`Every agent session in one list, whatever waits on you on top. Alt+j jumps there at the desk; the same conversation goes on from your phone.`}
          />
          <Point
            title={t`Tickets`}
            body={t`Hand work to another repository as a ticket. A headless agent researches and implements, and asks when it needs you.`}
          />
          <Point
            title={t`From anywhere`}
            body={t`A paired phone or tablet reaches the host over WebRTC, the relay as fallback. Writing takes a device you approved on the host.`}
          />
        </div>
      </section>

      <footer className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-5 py-8 text-[13px] text-brand-label">
        <span>WezDeck</span>
        <a
          href={SOURCE}
          target="_blank"
          rel="noreferrer"
          className="hover:text-brand-text"
        >
          github.com/yunsii/wezterm-config
        </a>
      </footer>
    </main>
  )
}

function Point({ title, body }: { title: string; body: string }) {
  return (
    <article className="grid content-start gap-2">
      <h2 className="text-[17px] font-semibold">{title}</h2>
      <p className="text-[15px] leading-relaxed text-brand-muted">{body}</p>
    </article>
  )
}

/** a still of the 会话 list: the console's own rows and lights, not a mock-up style */
function SessionStill() {
  const { t } = useLingui()
  const rows: Array<{
    tone: LedTone
    title: string
    prompt: string
    state: string
    tags: Array<string>
  }> = [
    {
      tone: 'waiting',
      title: 'team-stat',
      prompt: t`Which table should the weekly report read?`,
      state: t`waiting for your confirmation`,
      tags: ['claude', 'dev-report'],
    },
    {
      tone: 'running',
      title: 'wezterm-config',
      prompt: t`Tidy up the phone interactions`,
      state: t`working`,
      tags: ['claude', 'master'],
    },
    {
      tone: 'done',
      title: 'coco-platform',
      prompt: t`Add test ids to the error pages`,
      state: t`finished its turn`,
      tags: ['codex', 'task-e2e'],
    },
  ]
  return (
    <figure
      aria-hidden
      className="overflow-hidden rounded-[18px] border border-brand-edge bg-brand-surface shadow-[0_18px_50px_-24px_rgb(0_0_0/0.35)]"
    >
      <ul>
        {rows.map((row) => (
          <li
            key={row.title}
            className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-b border-brand-edge px-4 py-3.5 last:border-b-0"
          >
            <span className="pt-1">
              <Led tone={row.tone} size={11} />
            </span>
            <span className="truncate text-[15px] font-semibold">
              {row.title}
            </span>
            <span className="col-start-2 truncate text-[14px] text-brand-muted">
              {row.prompt}
            </span>
            <span className="col-start-2 flex flex-wrap gap-1.5 text-[12px] text-brand-label">
              <span>{row.state}</span>
              {row.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full border border-brand-edge px-2"
                >
                  {tag}
                </span>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </figure>
  )
}
