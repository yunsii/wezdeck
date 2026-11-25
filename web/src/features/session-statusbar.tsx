// The session's status under the composer, two lines of essentials:
//
//   agent:    the model · shell N · monitor N (background tasks by kind)
//   checkout: branch · git changes · linked N
//
// (a phone has little room: ctx and the account limits stay in the header,
// shown only when close to full; the permission mode and node stay at the
// terminal). Each line holds one row — the branch truncates first, the rest
// folds behind +N opening upward; the task lists and linked open upward over
// the thread, so nothing in it moves. The git tag keeps its width.
import { useLingui } from '@lingui/react/macro'
import { Popover as PopoverPrimitive } from '@base-ui/react/popover'
import { Bot, Layers, Radio, SquareTerminal } from 'lucide-react'

import {
  AGENT_MARKS,
  BranchTag,
  SessionTag,
  TagLine,
} from '#/components/deck/session-tags'
import { Led } from '#/components/deck/led'
import { PopoverContent } from '#/components/ui/popover'
import type { Detail } from './console-sessions'
import { BackgroundTasks } from './session-background'
import { GitStatusButton } from './session-git'

/** what the status bar adds to the session reply (session_env.go) */
export type StatusFields = {
  worktrees?: Array<{ path: string; branch?: string; current?: boolean }>
}

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

/** monitor (a Monitor stream) or shell (a background Bash) */
const kindOf = (task: NonNullable<Detail['background']>[number]) =>
  task.tool === 'Monitor' || task.type === 'monitor' ? 'monitor' : 'shell'

/** one kind of background task: its count, the list upward on a tap */
function Background({
  kind,
  tasks,
}: {
  kind: 'shell' | 'monitor'
  tasks: NonNullable<Detail['background']>
}) {
  const { t } = useLingui()
  const count = tasks.length
  const label =
    kind === 'monitor'
      ? t`${count} monitors running`
      : t`${count} shells running`
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger
        data-tone="accent"
        data-testid={`status-${kind}`}
        aria-label={label}
        title={label}
        className={trigger}
      >
        {kind === 'monitor' ? (
          <Radio size={11} aria-hidden className="shrink-0" />
        ) : (
          <SquareTerminal size={11} aria-hidden className="shrink-0" />
        )}
        {`${kind} ${count}`}
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

export function SessionStatusBar({ data }: { data?: Detail }) {
  if (!data) return null
  const agent = data.agent && data.agent !== 'agent' ? data.agent : ''
  const mark = AGENT_MARKS[agent.replace(/\.real$/, '')]
  const model = modelName(data.usage?.model) || agent
  const worktrees = data.worktrees ?? []
  const background = data.background ?? []
  const shells = background.filter((task) => kindOf(task) === 'shell')
  const monitors = background.filter((task) => kindOf(task) === 'monitor')
  const custom = Boolean(data.branch || data.git || worktrees.length > 1)
  if (!model && !background.length && !custom) return null
  return (
    // mt-1: 10 px under the composer, as the toolbar's buttons sit 10 px
    // above it (the toolbar box pads its 32 px buttons by 4 px)
    <div data-testid="session-statusbar" className="mt-1 grid gap-1">
      {model || background.length ? (
        // the agent: its model, what runs in the background by kind
        <TagLine testId="statusbar-agent" maxLines={1} panelSide="top">
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
          {shells.length ? <Background kind="shell" tasks={shells} /> : null}
          {monitors.length ? (
            <Background kind="monitor" tasks={monitors} />
          ) : null}
        </TagLine>
      ) : null}
      {custom ? (
        // the checkout: branch, git changes, linked worktrees
        <TagLine
          testId="statusbar-custom"
          maxLines={1}
          panelSide="top"
          className="session-statusbar"
        >
          {data.branch ? <BranchTag branch={data.branch} /> : null}
          {/* right after the branch: when its width moves, the branch's
              truncation takes it up */}
          {data.git ? (
            <GitStatusButton id={data.id} git={data.git} fixed />
          ) : null}
          {worktrees.length > 1 ? <Linked list={worktrees} /> : null}
        </TagLine>
      ) : null}
    </div>
  )
}
