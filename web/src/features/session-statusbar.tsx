// The session's status under the composer, in two bars like the terminal:
//
//   agent:  the model · ctx % · 5h / 7d limits · permission mode · background
//   custom: repo · branch · git changes · node · linked N · 主仓 / worktree
//
// (Claude Code's status line, then the tmux status line the person set up;
// WakaTime lives in the top banner already.) Pills, one line for the agent
// bar and at most two for the custom one; the branch truncates first, the
// rest folds behind +N opening upward. ctx, linked and the background tasks
// open upward over the conversation, so nothing in the thread moves. The
// header keeps the title.
import { useLingui } from '@lingui/react/macro'
import { Popover as PopoverPrimitive } from '@base-ui/react/popover'
import { Bot, Gauge, Hexagon, Layers, PlayCircle } from 'lucide-react'

import {
  AGENT_MARKS,
  BranchTag,
  RepoTag,
  SessionTag,
  TagLine,
} from '#/components/deck/session-tags'
import { Led } from '#/components/deck/led'
import { PopoverContent } from '#/components/ui/popover'
import type { Detail, RateWindow } from './console-sessions'
import { BackgroundTasks } from './session-background'
import { GitStatusButton } from './session-git'

/** what the status bar adds to the session reply (session_env.go, …) */
export type StatusFields = {
  node?: string
  worktrees?: Array<{ path: string; branch?: string; current?: boolean }>
  /** Claude's permission mode (auto, plan, bypassPermissions …) */
  mode?: string
  repo_label?: string
}

/** amber from here on */
const NEAR_FULL = 80

const trigger =
  'session-tag cursor-pointer text-meta outline-none focus-visible:ring-2 focus-visible:ring-brand-running'

/** claude-opus-5-5 → Opus 5.5 (claude-sonnet-4-5-20250929 → Sonnet 4.5) */
export function modelName(id?: string) {
  if (!id) return ''
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(id)
  if (!m) return id
  const family = m[1]
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
}

const percent = (n: number) => `${Math.round(n)}%`
const tokens = (n: number) =>
  n >= 10_000 ? `${(n / 10_000).toFixed(n >= 100_000 ? 0 : 1)} 万` : String(n)

/** hours (or minutes) until a window resets */
function resetIn(w: RateWindow) {
  if (!w.resets_at) return ''
  const minutes = Math.max(
    0,
    Math.round((w.resets_at * 1000 - Date.now()) / 60_000),
  )
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h` : `${minutes}m`
}

function Context({ data }: { data: Detail }) {
  const { t } = useLingui()
  const usage = data.usage
  if (!usage?.context_limit) return null
  const share = (usage.context / usage.context_limit) * 100
  const hit =
    usage.input + usage.cache_read
      ? Math.round((usage.cache_read / (usage.input + usage.cache_read)) * 100)
      : 0
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger
        data-tone={share >= NEAR_FULL ? 'waiting' : 'neutral'}
        data-testid="status-context"
        className={trigger}
      >
        <Gauge size={11} aria-hidden className="shrink-0" />
        {usage.context_pending ? 'ctx …' : `ctx ${percent(share)}`}
      </PopoverPrimitive.Trigger>
      <PopoverContent side="top" sideOffset={6} className="px-3 py-2">
        <dl
          data-testid="status-context-detail"
          className="grid grid-cols-[auto_auto] gap-x-4 gap-y-1 text-meta"
        >
          <dt className="text-brand-label">{t`Model`}</dt>
          <dd className="font-mono">{usage.model ?? '—'}</dd>
          <dt className="text-brand-label">{t`Context`}</dt>
          <dd className="tabular-nums">
            {tokens(usage.context)} / {tokens(usage.context_limit)}
          </dd>
          <dt className="text-brand-label">{t`Output`}</dt>
          <dd className="tabular-nums">{tokens(usage.output)}</dd>
          <dt className="text-brand-label">{t`Cache hit`}</dt>
          <dd className="tabular-nums">{percent(hit)}</dd>
        </dl>
      </PopoverContent>
    </PopoverPrimitive.Root>
  )
}

function Limit({
  label,
  window: w,
  onlyNearFull = false,
}: {
  label: string
  window?: RateWindow
  /** the 5-hour one: only once it is close (the terminal shows 7d alone) */
  onlyNearFull?: boolean
}) {
  const { t } = useLingui()
  if (!w || (onlyNearFull && w.used_percentage < NEAR_FULL)) return null
  // a snapshot taken before its window reset says nothing about now
  if (w.resets_at && w.resets_at * 1000 < Date.now()) return null
  const reset = resetIn(w)
  return (
    <SessionTag
      tone={w.used_percentage >= NEAR_FULL ? 'waiting' : 'neutral'}
      hint={reset ? t`${label} limit, resets in ${reset}` : undefined}
    >
      {`${label} ${percent(w.used_percentage)}${reset ? ` · ${reset}` : ''}`}
    </SessionTag>
  )
}

function Mode({ mode }: { mode?: string }) {
  const { t } = useLingui()
  if (!mode || mode === 'default' || mode === 'normal') return null
  const names: Record<string, string> = {
    auto: 'auto',
    plan: 'plan',
    acceptEdits: 'accept edits',
    bypassPermissions: 'bypass',
  }
  return (
    <SessionTag
      tone={
        mode === 'bypassPermissions'
          ? 'waiting'
          : mode === 'plan'
            ? 'accent'
            : 'neutral'
      }
      icon={PlayCircle}
      hint={t`Permission mode: ${mode}`}
    >
      {names[mode] ?? mode}
    </SessionTag>
  )
}

function Background({ tasks }: { tasks: NonNullable<Detail['background']> }) {
  const { t } = useLingui()
  const count = tasks.length
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger
        data-tone="accent"
        data-testid="status-background"
        aria-label={t`${count} background tasks`}
        title={t`${count} background tasks`}
        className={trigger}
      >
        <Led tone="running" size={7} className="led-running" />
        {/* compact on the bar; the words for hover and readers */}
        <span aria-hidden>{count}</span>
      </PopoverPrimitive.Trigger>
      {/* upward, over the thread: opening it used to push the messages */}
      <PopoverContent
        side="top"
        sideOffset={6}
        className="w-[min(26rem,calc(100vw-2rem))] p-0"
      >
        <BackgroundTasks tasks={tasks} />
      </PopoverContent>
    </PopoverPrimitive.Root>
  )
}

function Linked({ list }: { list: NonNullable<Detail['worktrees']> }) {
  const { t } = useLingui()
  // the terminal's linked:N — every worktree but the main checkout (first)
  const linked = list.length - 1
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger
        data-tone="neutral"
        data-testid="status-worktrees"
        title={t`${linked} linked worktrees`}
        className={trigger}
      >
        <Layers size={11} aria-hidden className="shrink-0" />
        {`linked ${linked}`}
      </PopoverPrimitive.Trigger>
      <PopoverContent
        side="top"
        sideOffset={6}
        className="w-[min(22rem,calc(100vw-2rem))] p-2"
      >
        <ul className="grid gap-0.5" data-testid="status-worktree-list">
          {list.map((wt) => (
            <li
              key={wt.path}
              className="grid min-w-0 gap-0.5 rounded-lg px-1.5 py-1"
              data-current={wt.current ? '' : undefined}
            >
              <span className="flex min-w-0 items-center gap-1.5 font-mono text-meta text-brand-text">
                {wt.current ? <Led tone="running" size={7} /> : null}
                <span className="truncate">{wt.branch ?? '—'}</span>
              </span>
              <span className="truncate font-mono text-meta text-brand-label">
                {wt.path}
              </span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </PopoverPrimitive.Root>
  )
}

/** 主仓 on the main checkout, else the worktree's folder (dev-agent …) */
function Checkout({ list }: { list: NonNullable<Detail['worktrees']> }) {
  const { t } = useLingui()
  const current = list.find((wt) => wt.current)
  if (!current) return null
  const main = list[0]?.path === current.path
  return (
    <SessionTag tone={main ? 'done' : 'accent'} mono={!main}>
      {main ? t`main checkout` : (current.path.split('/').at(-1) ?? '')}
    </SessionTag>
  )
}

export function SessionStatusBar({ data }: { data?: Detail }) {
  if (!data) return null
  const agent = data.agent && data.agent !== 'agent' ? data.agent : ''
  const mark = AGENT_MARKS[agent.replace(/\.real$/, '')]
  const model = modelName(data.usage?.model) || agent
  const worktrees = data.worktrees ?? []
  const background = data.background ?? []
  return (
    // mt-1: 10 px under the composer, as the toolbar's buttons sit 10 px
    // above it (the toolbar box pads its 32 px buttons by 4 px)
    <div data-testid="session-statusbar" className="mt-1 grid gap-1">
      {model || data.usage || background.length ? (
        // two lines like Claude Code's own (model · ctx · 7d, then the mode)
        <TagLine testId="statusbar-agent" maxLines={2} panelSide="top">
          {model ? (
            <SessionTag
              tone={mark?.tone ?? 'neutral'}
              icon={mark?.icon ?? Bot}
              mono
              hint={data.usage?.model ?? agent}
            >
              {model}
            </SessionTag>
          ) : null}
          <Context data={data} />
          <Limit label="5h" window={data.account?.five_hour} onlyNearFull />
          <Limit label="7d" window={data.account?.seven_day} />
          <Mode mode={data.mode} />
          {background.length ? <Background tasks={background} /> : null}
        </TagLine>
      ) : null}
      {data.branch || data.git || data.node || worktrees.length ? (
        <TagLine
          testId="statusbar-custom"
          maxLines={2}
          panelSide="top"
          className="session-statusbar"
        >
          {data.repo_label ? <RepoTag repo={data.repo_label} /> : null}
          {data.branch ? <BranchTag branch={data.branch} /> : null}
          {data.git ? <GitStatusButton id={data.id} git={data.git} /> : null}
          {data.node ? (
            <SessionTag icon={Hexagon} mono hint={`node ${data.node}`}>
              {data.node}
            </SessionTag>
          ) : null}
          {worktrees.length > 1 ? <Linked list={worktrees} /> : null}
          {worktrees.length ? <Checkout list={worktrees} /> : null}
        </TagLine>
      ) : null}
    </div>
  )
}
