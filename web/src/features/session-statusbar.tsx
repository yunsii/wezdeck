// The session's status line under the composer, like the terminal's tmux
// status bar: the agent, branch and git changes, the node version, the
// repo's worktrees and the background tasks — moved down from the header,
// which keeps the title. One line (the branch truncates, its text in a tip);
// what does not fit folds behind +N. Worktrees and background tasks open
// upward over the conversation, so nothing in the thread moves.
import { useLingui } from '@lingui/react/macro'
import { Popover as PopoverPrimitive } from '@base-ui/react/popover'
import { FolderTree, Hexagon } from 'lucide-react'

import {
  AgentTag,
  BranchTag,
  SessionTag,
  TagLine,
} from '#/components/deck/session-tags'
import { Led } from '#/components/deck/led'
import { PopoverContent } from '#/components/ui/popover'
import type { Detail } from './console-sessions'
import { BackgroundTasks } from './session-background'
import { GitStatusButton } from './session-git'

const trigger =
  'session-tag cursor-pointer text-meta outline-none focus-visible:ring-2 focus-visible:ring-brand-running'

function Worktrees({ list }: { list: NonNullable<Detail['worktrees']> }) {
  const { t } = useLingui()
  const count = list.length
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger
        data-tone="neutral"
        data-testid="status-worktrees"
        aria-label={t`${count} worktrees`}
        title={t`${count} worktrees`}
        className={trigger}
      >
        <FolderTree size={11} aria-hidden className="shrink-0" />
        {count}
      </PopoverPrimitive.Trigger>
      <PopoverContent
        side="top"
        sideOffset={6}
        className="w-[min(22rem,calc(100vw-2rem))] p-2"
      >
        <p className="px-1 pb-1 text-meta text-brand-label">
          {t`${count} worktrees`}
        </p>
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

export function SessionStatusBar({ data }: { data?: Detail }) {
  if (!data) return null
  const agent = data.agent && data.agent !== 'agent' ? data.agent : ''
  const worktrees = data.worktrees ?? []
  const background = data.background ?? []
  if (!agent && !data.branch && !data.git && !data.node && !background.length)
    return null
  return (
    <TagLine
      testId="session-statusbar"
      maxLines={1}
      panelSide="top"
      className="session-statusbar"
    >
      {agent ? <AgentTag agent={agent} compact /> : null}
      {data.branch ? <BranchTag branch={data.branch} /> : null}
      {data.git ? <GitStatusButton id={data.id} git={data.git} /> : null}
      {data.node ? (
        <SessionTag icon={Hexagon} mono hint={`node ${data.node}`}>
          {data.node.replace(/^v/, '')}
        </SessionTag>
      ) : null}
      {worktrees.length > 1 ? <Worktrees list={worktrees} /> : null}
      {background.length ? <Background tasks={background} /> : null}
    </TagLine>
  )
}
