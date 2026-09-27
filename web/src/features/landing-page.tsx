import { useLingui } from '@lingui/react/macro'
import {
  ArrowRight,
  Command,
  GitBranch,
  Keyboard,
  MonitorCog,
  Radio,
  Zap,
} from 'lucide-react'
import { Link } from '@tanstack/react-router'

import { useLocale } from '#/lib/locale-context'
import { useTheme } from '#/lib/theme-provider'

import { LanguageSwitcher, ThemeSwitcher } from './console-shared'
import { ConsoleExample, WorkbenchExample } from './landing-example'

export function LandingPage() {
  const { t } = useLingui()
  const { locale } = useLocale()
  const { mode, setMode } = useTheme()
  const localeParam = locale === 'en' ? undefined : locale

  return (
    <main className="landing-shell">
      <header className="landing-nav">
        <div className="landing-container flex items-center justify-between gap-4 py-5">
          <Link
            to="/{-$locale}"
            params={{ locale: localeParam }}
            className="landing-brand"
          >
            <img
              className="landing-brand-mark"
              src="/brand-icon.svg"
              alt=""
              width="30"
              height="30"
            />
            <span>WezDeck</span>
          </Link>
          <div className="flex items-center gap-8">
            <nav className="hidden items-center gap-6 text-sm text-brand-muted md:flex">
              <a href="#deck">{t`Workbench`}</a>
              <a href="#capabilities">{t`Capabilities`}</a>
              <a href="#console">{t`Runtime Console`}</a>
            </nav>
            <div className="flex items-center gap-2">
              <LanguageSwitcher locale={locale} />
              <ThemeSwitcher mode={mode} onChange={setMode} />
            </div>
          </div>
        </div>
      </header>

      <section id="deck" className="landing-hero landing-container">
        <div className="landing-hero-copy">
          <p className="landing-eyebrow">
            <span className="landing-eyebrow-dot" />
            {t`Local-first control plane`}
          </p>
          <h1>{t`WezDeck`}</h1>
          <p className="landing-lede">
            {t`A local-first control plane for AI coding agents, built on WezTerm, tmux, and git worktrees.`}
          </p>
          <div className="landing-actions">
            <a href="#capabilities" className="landing-primary-action">
              {t`See the workbench`}
              <ArrowRight size={17} />
            </a>
            <Link
              to="/{-$locale}/console"
              params={{ locale: localeParam }}
              className="landing-secondary-action"
            >
              <MonitorCog size={16} />
              {t`Open web console`}
            </Link>
          </div>
          <dl className="landing-proof-row">
            <div>
              <dt>{t`Workspace`}</dt>
              <dd>{t`One home for every repo`}</dd>
            </div>
            <div>
              <dt>{t`Agents`}</dt>
              <dd>{t`Resumed conversations`}</dd>
            </div>
            <div>
              <dt>{t`Control`}</dt>
              <dd>{t`Keyboard first`}</dd>
            </div>
          </dl>
        </div>

        <WorkbenchExample />
      </section>

      <section id="capabilities" className="landing-section landing-container">
        <div className="landing-section-heading">
          <p className="landing-eyebrow">{t`The workbench`}</p>
          <h2>{t`Keep every agent in a place you can return to.`}</h2>
          <p>
            {t`WezDeck organizes workspaces, git worktrees, and agent sessions into one keyboard-first local control plane.`}
          </p>
        </div>
        <div className="landing-feature-grid">
          <FeatureTile
            icon={<MonitorCog size={20} />}
            title={t`Workspace, worktree, agent`}
            body={t`Each repository, linked worktree, and agent session keeps a place you can jump back to.`}
          />
          <FeatureTile
            icon={<Radio size={20} />}
            title={t`See who needs you`}
            body={t`Waiting, running, and done stay visible, so the next jump is obvious.`}
          />
          <FeatureTile
            icon={<Keyboard size={20} />}
            title={t`Resume the thread`}
            body={t`After a restart, return to the same agent session and continue the work.`}
          />
        </div>
      </section>

      <section id="console" className="landing-band">
        <div className="landing-container landing-companion">
          <div className="landing-companion-copy">
            <p className="landing-eyebrow">{t`Optional browser companion`}</p>
            <h2>{t`Runtime Console shows the local signals.`}</h2>
            <p>
              {t`Open a browser when you want Runtime health, IME state, Chrome debug, and Rime statistics. The console observes the workbench. The work stays in the terminal.`}
            </p>
            <Link
              to="/{-$locale}/console"
              params={{ locale: localeParam }}
              className="landing-primary-action"
            >
              {t`Open Runtime Console`}
              <ArrowRight size={17} />
            </Link>
          </div>
          <ConsoleExample />
        </div>
      </section>

      <section className="landing-final landing-container">
        <div className="landing-final-icon">
          <Command size={22} />
        </div>
        <p className="landing-eyebrow">{t`Open source, local by design`}</p>
        <h2>{t`Your agents. Your worktrees. Your machine.`}</h2>
        <p>
          {t`Start with the keyboard-first control plane and add the browser view when you need it.`}
        </p>
        <div className="landing-actions">
          <a
            href="https://github.com/yunsii/wezterm-config"
            className="landing-primary-action"
            target="_blank"
            rel="noreferrer"
          >
            <GitBranch size={16} />
            {t`View the source`}
          </a>
          <Link
            to="/{-$locale}/console"
            params={{ locale: localeParam }}
            className="landing-secondary-action"
          >
            <Zap size={17} />
            {t`Enter Runtime Console`}
          </Link>
        </div>
      </section>

      <footer className="landing-footer">
        <div className="landing-container flex flex-wrap items-center justify-between gap-3 py-6">
          <span>WezDeck</span>
          <span>{t`A local-first workbench for AI coding agents.`}</span>
        </div>
      </footer>
    </main>
  )
}

function FeatureTile({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode
  title: string
  body: string
}) {
  return (
    <article className="landing-feature-tile">
      <div className="landing-feature-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{body}</p>
    </article>
  )
}
