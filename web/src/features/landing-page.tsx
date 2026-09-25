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

import { LanguageSwitcher, ThemeSwitcher } from './runtime-console'

export function LandingPage() {
  const { t } = useLingui()
  const { locale } = useLocale()
  const { mode, setMode } = useTheme()
  const consolePath = locale === 'zh' ? '/zh/console' : '/console'

  return (
    <main className="landing-shell">
      <header className="landing-nav">
        <div className="landing-container flex items-center justify-between gap-4 py-5">
          <Link to={locale === 'zh' ? '/zh' : '/'} className="landing-brand">
            <img
              className="landing-brand-mark"
              src="/brand-icon.svg"
              alt=""
              width="30"
              height="30"
            />
            <span>WezDeck</span>
          </Link>
          <div className="flex items-center gap-2">
            <nav className="hidden items-center gap-6 text-sm text-brand-muted md:flex">
              <a href="#deck">{t`AI Deck`}</a>
              <a href="#capabilities">{t`Capabilities`}</a>
              <a href="#console">{t`Web console`}</a>
            </nav>
            <LanguageSwitcher locale={locale} />
            <ThemeSwitcher mode={mode} onChange={setMode} />
          </div>
        </div>
      </header>

      <section id="deck" className="landing-hero landing-container">
        <div className="landing-hero-copy">
          <p className="landing-eyebrow">
            <span className="landing-eyebrow-dot" />
            {t`Local-first AI Deck`}
          </p>
          <h1>{t`WezDeck`}</h1>
          <p className="landing-lede">
            {t`A flight deck for your AI agents — built on WezTerm, tmux, and git worktrees.`}
          </p>
          <div className="landing-actions">
            <a href="#capabilities" className="landing-primary-action">
              {t`Explore the AI Deck`}
              <ArrowRight size={17} />
            </a>
            <Link to={consolePath} className="landing-secondary-action">
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

        <DeckPreview />
      </section>

      <section id="capabilities" className="landing-section landing-container">
        <div className="landing-section-heading">
          <p className="landing-eyebrow">{t`The deck is the product`}</p>
          <h2>{t`Coordinate agent work without leaving the terminal.`}</h2>
          <p>
            {t`WezDeck turns workspaces, git worktrees, agent sessions, and attention into one surface you can navigate by feel.`}
          </p>
        </div>
        <div className="landing-feature-grid">
          <FeatureTile
            icon={<MonitorCog size={20} />}
            title={t`Workspace × worktree × agent`}
            body={t`Keep each repository, linked worktree, and agent conversation in a predictable slot.`}
          />
          <FeatureTile
            icon={<Radio size={20} />}
            title={t`Attention at a glance`}
            body={t`Waiting, done, and running signals stay visible so you know where to jump next.`}
          />
          <FeatureTile
            icon={<Keyboard size={20} />}
            title={t`Resume the thread`}
            body={t`Return to the right agent session after a restart and keep the loop moving.`}
          />
        </div>
      </section>

      <section id="console" className="landing-band">
        <div className="landing-container landing-companion">
          <div className="landing-companion-copy">
            <p className="landing-eyebrow">{t`Optional browser companion`}</p>
            <h2>{t`Runtime Console keeps the local signals in view.`}</h2>
            <p>
              {t`When you want a browser window, the local web console shows Runtime health, IME state, Chrome debug, and Rime statistics. It observes the Deck; it does not replace it.`}
            </p>
            <Link to={consolePath} className="landing-primary-action">
              {t`Open Runtime Console`}
              <ArrowRight size={17} />
            </Link>
          </div>
          <figure className="landing-console-figure">
            <div className="landing-window-bar">
              <span className="landing-window-dot" />
              <span className="landing-window-dot" />
              <span className="landing-window-dot" />
              <span className="landing-window-title">localhost / console</span>
            </div>
            <div className="landing-console-preview">
              <img
                className="console-preview-light"
                src="/console-preview-light.png"
                alt={t`WezDeck Runtime Console showing live local runtime signals in light theme`}
              />
              <img
                className="console-preview-dark"
                src="/console-preview-dark.png"
                alt={t`WezDeck Runtime Console showing live local runtime signals in dark theme`}
              />
            </div>
            <figcaption>{t`A local view into the Deck runtime.`}</figcaption>
          </figure>
        </div>
      </section>

      <section className="landing-final landing-container">
        <div className="landing-final-icon">
          <Command size={22} />
        </div>
        <p className="landing-eyebrow">{t`Open source, local by design`}</p>
        <h2>{t`Your agents. Your worktrees. Your deck.`}</h2>
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
          <Link to={consolePath} className="landing-secondary-action">
            <Zap size={17} />
            {t`Enter Runtime Console`}
          </Link>
        </div>
      </section>

      <footer className="landing-footer">
        <div className="landing-container flex flex-wrap items-center justify-between gap-3 py-6">
          <span>WezDeck</span>
          <span>{t`A flight deck for your AI agents.`}</span>
        </div>
      </footer>
    </main>
  )
}

function DeckPreview() {
  const { t } = useLingui()
  const slots = [
    { repo: 'wezdeck', agent: 'Claude', state: 'running' as const },
    { repo: 'runtime-api', agent: 'Codex', state: 'waiting' as const },
    { repo: 'web-console', agent: 'Grok', state: 'done' as const },
    { repo: 'picker', agent: 'Codex', state: 'running' as const },
    { repo: 'openclaw', agent: 'Claude', state: 'waiting' as const },
    { repo: 'docs', agent: 'Codex', state: 'done' as const },
  ]
  const stateLabels = {
    running: t`running`,
    waiting: t`waiting`,
    done: t`done`,
  }

  return (
    <figure className="landing-deck-figure">
      <div className="landing-deck-toolbar">
        <span className="landing-window-title">wezdeck / ai deck</span>
        <span className="landing-deck-live">
          <span /> {t`6 slots`}
        </span>
      </div>
      <div className="landing-deck-context">
        <span>{t`WORKSPACE`}</span>
        <strong>default</strong>
        <span className="landing-deck-context-status">
          {t`3 waiting · 2 running · 1 done`}
        </span>
      </div>
      <div className="landing-deck-grid">
        {slots.map((slot) => (
          <div className={`landing-deck-slot is-${slot.state}`} key={slot.repo}>
            <div className="landing-deck-slot-top">
              <span className="landing-deck-state" />
              <span>{stateLabels[slot.state]}</span>
            </div>
            <strong>{slot.repo}</strong>
            <span className="landing-deck-agent">{slot.agent} · tmux</span>
          </div>
        ))}
      </div>
      <figcaption>
        {t`Workspaces, worktrees, and agents in one keyboard-first frame.`}
      </figcaption>
    </figure>
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
