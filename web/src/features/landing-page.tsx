// The landing page, in the console's ink theme ([data-deck]) and Telegram-style
// flat visual language: shared sticky PublicHeader, one-line pitch + console
// entry, an interactive preview built with the console's own IM chat rows and
// AgentAvatar marks, and three flat feature slices (sessions, tickets, from
// anywhere). No marketing chrome.
import { useLingui } from '@lingui/react/macro'
import { Link } from '@tanstack/react-router'
import {
  ArrowRight,
  FolderGit2,
  GitBranch,
  Keyboard,
  ShieldCheck,
} from 'lucide-react'
import { useState } from 'react'

import { Led } from '#/components/deck/led'
import { Button } from '#/components/ui/button'
import { useLocale } from '#/lib/locale-context'
import { cn } from '#/lib/utils'
import { AgentAvatar } from './agent-avatar'
import { PublicHeader, SOURCE_URL } from './public-header'
import type { ChatTone } from './session-chats'

type PreviewChat = {
  id: string
  repo: string
  agent: 'claude' | 'codex' | 'grok'
  profile?: string
  tone: ChatTone
  title: string
  time: string
  preview: string
  unread?: number
  userLine: string
  agentReply: string
  actionHint?: string
}

export function LandingPage() {
  const { t } = useLingui()
  const { locale } = useLocale()
  const localeParam = locale === 'en' ? undefined : locale
  return (
    <main data-deck className="min-h-dvh bg-brand-deck text-brand-text">
      <PublicHeader active="landing" />

      <section className="mx-auto grid max-w-5xl items-center gap-10 px-4 pt-10 pb-14 sm:px-5 md:grid-cols-[minmax(0,1fr)_minmax(0,29rem)] md:pt-16 md:pb-20">
        <div className="grid content-start gap-5">
          <h1 className="text-[42px] leading-none font-semibold tracking-tight md:text-[58px]">
            WezDeck
          </h1>
          <p className="max-w-xl text-title leading-relaxed text-brand-muted md:text-heading md:font-normal">
            {t`A local-first web console for AI coding sessions. tmux keeps agents running; open a terminal only when you need the real TUI.`}
          </p>
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Link
              to="/{-$locale}/console"
              params={{ locale: localeParam }}
              className="key-press inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand-text px-5 text-body font-semibold text-brand-deck outline-none focus-visible:ring-2 focus-visible:ring-brand-running focus-visible:ring-offset-2 focus-visible:ring-offset-brand-deck"
            >
              {t`Open the console`}
              <ArrowRight size={16} aria-hidden />
            </Link>
            <Link
              to="/{-$locale}/architecture"
              params={{ locale: localeParam }}
              className="key-press inline-flex min-h-11 items-center gap-2 rounded-xl bg-brand-surface px-4 text-body font-medium text-brand-text outline-none hover:bg-brand-soft focus-visible:ring-2 focus-visible:ring-brand-running"
            >
              {t`How it fits together`}
            </Link>
            <a
              href={SOURCE_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-11 items-center gap-1.5 px-2 text-body text-brand-muted transition-colors hover:text-brand-text"
            >
              <GitBranch size={16} aria-hidden />
              {t`View the source`}
            </a>
          </div>
        </div>
        <SessionStill />
      </section>

      <section className="border-y border-brand-edge bg-brand-surface">
        <div className="mx-auto grid max-w-5xl gap-5 px-4 py-12 sm:px-5 md:grid-cols-3 md:py-16">
          <FeatureSlice
            title={t({ message: 'Sessions', context: 'nav' })}
            body={t`Every agent session in one list, with work waiting on you at the top. Read and reply from your computer or phone.`}
            preview={
              <div className="flex flex-wrap items-center gap-1.5 text-meta text-brand-muted">
                <Keyboard size={14} aria-hidden className="text-brand-label" />
                {['j / k', '/', 'Alt+J', '?'].map((key) => (
                  <kbd
                    key={key}
                    className="rounded-md bg-brand-surface px-1.5 py-0.5 font-mono text-meta text-brand-text"
                  >
                    {key}
                  </kbd>
                ))}
              </div>
            }
          />
          <FeatureSlice
            title={t`Tickets`}
            body={t`Hand work to another repository as a ticket. A headless agent researches and implements, and asks when it needs you.`}
            preview={
              <div className="grid gap-1 rounded-xl bg-brand-surface px-3 py-2">
                <div className="flex items-center gap-2">
                  <Led tone="waiting" size={10} />
                  <span className="truncate text-caption font-medium text-brand-text">
                    {t`Align API schema before release`}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 pl-4.5 text-meta text-brand-label">
                  <span className="text-brand-waiting">
                    {t`waiting on you`}
                  </span>
                  <span>·</span>
                  <span className="truncate font-mono">web → runtime</span>
                </div>
              </div>
            }
          />
          <FeatureSlice
            title={t`From anywhere`}
            body={t`A paired phone or tablet reaches the host over WebRTC, the relay as fallback. Writing takes a device you approved on the host.`}
            preview={
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-brand-surface px-3 py-2 text-meta">
                <span className="inline-flex items-center gap-1.5 text-brand-text">
                  <Led tone="running" size={9} />
                  {t`WebRTC direct`}
                  <span className="text-brand-label tabular-nums">12 ms</span>
                </span>
                <span className="inline-flex items-center gap-1 text-brand-done">
                  <ShieldCheck size={13} aria-hidden />
                  {t`Approved`}
                </span>
              </div>
            }
          />
        </div>
      </section>

      <footer className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-8 text-caption text-brand-label sm:px-5">
        <div className="flex flex-wrap items-center gap-4">
          <Link
            to="/{-$locale}/architecture"
            params={{ locale: localeParam }}
            className="transition-colors hover:text-brand-text"
          >
            {t`How it fits together`}
          </Link>
          <Link
            to="/{-$locale}/console"
            params={{ locale: localeParam }}
            className="transition-colors hover:text-brand-text"
          >
            {t`Open the console`}
          </Link>
        </div>
        <a
          href={SOURCE_URL}
          target="_blank"
          rel="noreferrer"
          className="transition-colors hover:text-brand-text"
        >
          github.com/yunsii/wezterm-config
        </a>
      </footer>
    </main>
  )
}

function FeatureSlice({
  title,
  body,
  preview,
}: {
  title: string
  body: string
  preview: React.ReactNode
}) {
  return (
    <article className="flex flex-col justify-between gap-4 rounded-2xl bg-brand-deck p-5">
      <div className="grid content-start gap-2">
        <h2 className="text-title font-semibold text-brand-text">{title}</h2>
        <p className="text-body leading-relaxed text-brand-muted">{body}</p>
      </div>
      <div>{preview}</div>
    </article>
  )
}

/**
 * Interactive preview of the Telegram-style IM session list using the console's
 * own AgentAvatar, repo strip, inset hairlines (.chat-list), and .list-row
 * selection state. Clicking a row previews its conversation snippet below.
 */
function SessionStill() {
  const { t } = useLingui()
  const chats: Array<PreviewChat> = [
    {
      id: 'team-stat',
      repo: 'team-stat',
      agent: 'claude',
      tone: 'waiting',
      title: 'dev-report',
      time: '11:18',
      preview: t`Which table should the weekly report read?`,
      unread: 1,
      userLine: t`Pull last week's metrics into the weekly report.`,
      agentReply: t`Found both metrics_v1 and metrics_v2. Should I read from metrics_v2?`,
      actionHint: t`Waiting on you`,
    },
    {
      id: 'wezterm-config',
      repo: 'wezterm-config',
      agent: 'claude',
      profile: 'claude_kimi',
      tone: 'running',
      title: 'master',
      time: '11:04',
      preview: t`Tidy up the phone interactions`,
      userLine: t`Align the navigation rail and intro pages with the chat list.`,
      agentReply: t`Updating shell rail, sticky public header and architecture TOC…`,
    },
    {
      id: 'coco-platform',
      repo: 'coco-platform',
      agent: 'codex',
      tone: 'done',
      title: 'task-e2e',
      time: '10:42',
      preview: t`Add test ids to the error pages`,
      unread: 1,
      userLine: t`Add stable test ids to the 404 and 500 pages.`,
      agentReply: t`Added data-testid attributes and verified all 14 unit tests pass.`,
    },
  ]
  const [selectedId, setSelectedId] = useState(chats[0].id)
  const active = chats.find((chat) => chat.id === selectedId) ?? chats[0]

  return (
    <figure
      aria-label={t`Agent sessions`}
      className="overflow-hidden rounded-2xl border border-brand-edge bg-brand-surface shadow-[0_18px_50px_-24px_rgb(0_0_0/0.3)]"
    >
      {/* Flat Telegram-style session list */}
      <div>
        {chats.map((chat) => {
          const selected = chat.id === active.id
          return (
            <div key={chat.id}>
              <div className="flex items-center gap-1.5 border-y border-brand-edge/70 bg-brand-deck px-3 py-1 text-meta font-semibold text-brand-label first:border-t-0">
                <FolderGit2 size={12} aria-hidden className="shrink-0" />
                <span className="truncate">{chat.repo}</span>
              </div>
              <ul className="chat-list">
                <li>
                  <Button
                    variant="plain"
                    size="none"
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setSelectedId(chat.id)}
                    className={cn(
                      'list-row flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left',
                      selected && 'row-selected',
                    )}
                  >
                    <AgentAvatar
                      agent={chat.agent}
                      profile={chat.profile}
                      size={38}
                      tone={chat.tone}
                    />
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <span className="flex items-baseline justify-between gap-2">
                        <span
                          className={cn(
                            'min-w-0 truncate text-body',
                            chat.unread ? 'font-semibold' : 'font-medium',
                          )}
                        >
                          {chat.title}
                        </span>
                        <span className="shrink-0 text-meta text-brand-label tabular-nums">
                          {chat.time}
                        </span>
                      </span>
                      <span className="flex min-w-0 items-center justify-between gap-2 text-caption">
                        <span
                          className={cn(
                            'min-w-0 truncate',
                            chat.tone === 'waiting' && 'text-brand-waiting',
                            chat.tone === 'running' && 'text-brand-running',
                            chat.tone === 'done' && 'text-brand-done',
                          )}
                        >
                          {chat.preview}
                        </span>
                        {chat.unread ? (
                          <span
                            className={cn(
                              'inline-flex min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-meta font-semibold tabular-nums',
                              chat.tone === 'done'
                                ? 'bg-brand-done text-[#0b1a12]'
                                : 'bg-brand-waiting text-[#1b1406]',
                            )}
                          >
                            {chat.unread}
                          </span>
                        ) : null}
                      </span>
                    </span>
                  </Button>
                </li>
              </ul>
            </div>
          )
        })}
      </div>

      {/* Live conversation snippet matching the selected chat */}
      <div className="grid gap-2 border-t border-brand-edge bg-brand-deck p-3">
        <div className="flex items-center justify-between gap-2 text-meta text-brand-label">
          <span className="truncate font-medium text-brand-text">
            {active.repo} · {active.title}
          </span>
          {active.actionHint ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-brand-waiting">
              <Led tone="waiting" size={8} />
              {active.actionHint}
            </span>
          ) : active.tone === 'running' ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-brand-running">
              <Led tone="running" size={8} />
              {t`Working`}
            </span>
          ) : (
            <span className="inline-flex shrink-0 items-center gap-1 text-brand-done">
              <Led tone="done" size={8} />
              {t`Done`}
            </span>
          )}
        </div>
        <div className="rounded-xl bg-brand-text px-3 py-2 text-caption leading-snug text-brand-deck">
          {active.userLine}
        </div>
        <div className="rounded-xl bg-brand-surface px-3 py-2 text-caption leading-snug text-brand-text">
          {active.agentReply}
        </div>
      </div>
    </figure>
  )
}
