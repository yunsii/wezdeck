// The session's status under the composer, two lines of essentials:
//
//   agent:    the model · shell N · monitor N (background tasks by kind)
//   checkout: git changes
//
// Branch and worktree identity live in session information's technical details;
// this bar keeps only state that can change the next action.
import { useLingui } from '@lingui/react/macro'
import { Popover as PopoverPrimitive } from '@base-ui/react/popover'
import {
  Bot,
  Radio,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  SquareTerminal,
} from 'lucide-react'

import {
  AGENT_MARKS,
  SessionTag,
  TagLine,
} from '#/components/deck/session-tags'
import type { Tone } from '#/components/deck/session-tags'
import { PopoverContent } from '#/components/ui/popover'
import type { Detail } from './console-sessions'
import { BackgroundTasks } from './session-background'
import { GitStatusButton } from './session-git'
import { UsageTag, usageMetrics } from './session-usage'

/** what the status bar adds to the session reply (session_env.go) */
export type StatusFields = {
  worktrees?: Array<{ path: string; branch?: string; current?: boolean }>
  restart_pending?: boolean
}

const trigger =
  'session-tag cursor-pointer text-meta outline-none focus-visible:ring-2 focus-visible:ring-brand-running'

/** claude-opus-5-5 → Opus 5.5; gemini-4-neon-high → Gemini 4 Neon (high) */
export function modelName(id?: string) {
  if (!id) return ''
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(id)
  if (claude) {
    const family = claude[1]
    return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`
  }
  const gemini = /^gemini-(.+)$/.exec(id)
  if (gemini) {
    const parts = gemini[1].split('-').filter(Boolean)
    const efforts = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
    const last = parts.at(-1)
    const effort = last && efforts.has(last) ? parts.pop() : ''
    const title = parts
      .map((part) =>
        /^[a-z]/.test(part)
          ? part.charAt(0).toUpperCase() + part.slice(1)
          : part,
      )
      .join(' ')
    return effort ? `Gemini ${title} (${effort})` : `Gemini ${title}`
  }
  return id
}

export type ModeKind =
  'auto' | 'full-access' | 'accept-edits' | 'plan' | 'default' | 'other'

export function normalizeMode(mode?: string): ModeKind | '' {
  const s = (mode ?? '').trim().toLowerCase()
  if (!s) return ''
  if (s === 'auto') return 'auto'
  if (s === 'full-access' || s === 'bypasspermissions' || s === 'dontask')
    return 'full-access'
  if (s === 'accept-edits' || s === 'acceptedits') return 'accept-edits'
  if (s === 'plan') return 'plan'
  if (s === 'default') return 'default'
  return 'other'
}

function ModeTag({ mode }: { mode: string }) {
  const { t } = useLingui()
  const kind = normalizeMode(mode)
  if (!kind) return null
  const config: Record<
    ModeKind,
    { label: string; hint: string; tone: Tone; icon: typeof Shield }
  > = {
    auto: {
      label: t`Auto`,
      hint: t`Auto mode enabled`,
      tone: 'done',
      icon: ShieldCheck,
    },
    'full-access': {
      label: t`Full access`,
      hint: t`Full access: auto-approves all actions`,
      tone: 'waiting',
      icon: ShieldAlert,
    },
    'accept-edits': {
      label: t`Accept edits`,
      hint: t`Auto-approves edits; auto mode off`,
      tone: 'accent',
      icon: Shield,
    },
    plan: {
      label: t`Plan`,
      hint: t`Plan mode`,
      tone: 'accent',
      icon: Shield,
    },
    default: {
      label: t`Auto off`,
      hint: t`Default mode: auto mode is off`,
      tone: 'neutral',
      icon: ShieldOff,
    },
    other: {
      label: mode,
      hint: t`Execution mode: ${mode}`,
      tone: 'neutral',
      icon: Shield,
    },
  }
  const item = config[kind]
  return (
    <SessionTag
      testId="status-mode"
      tone={item.tone}
      icon={item.icon}
      hint={item.hint}
    >
      {item.label}
    </SessionTag>
  )
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

export function SessionStatusBar({
  data,
  onVisibleUsage,
}: {
  data?: Detail
  onVisibleUsage?: (ids: string) => void
}) {
  if (!data) return null
  const agent = data.agent && data.agent !== 'agent' ? data.agent : ''
  const mark = AGENT_MARKS[agent.replace(/\.real$/, '')]
  const model = modelName(data.usage?.model) || agent
  const mode = data.mode?.trim() || ''
  const metrics = usageMetrics(data.usage, data.account)
  const background = data.background ?? []
  const shells = background.filter((task) => kindOf(task) === 'shell')
  const monitors = background.filter((task) => kindOf(task) === 'monitor')
  const custom = Boolean(data.git)
  if (!model && !mode && !background.length && !metrics.length && !custom)
    return null
  return (
    // Integer 24 px rows (`h-6` = 63.0 physical px at 2.625× DPR) with `gap-0`
    // keep ~4 px visual separation between the 20 px pills while snapping every
    // row boundary to exact physical pixels; `isolate` decouples stacking from
    // the blinking composer pill above.
    <div
      data-testid="session-statusbar"
      className="isolate mt-0.5 grid gap-0 md:mt-0"
    >
      {model || mode || background.length || metrics.length ? (
        // the agent: its model, execution mode, what runs in the background by kind
        <TagLine
          testId="statusbar-agent"
          maxLines={1}
          panelSide="top"
          onVisibleTags={onVisibleUsage}
        >
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
          {mode ? <ModeTag mode={mode} /> : null}
          {shells.length ? <Background kind="shell" tasks={shells} /> : null}
          {monitors.length ? (
            <Background kind="monitor" tasks={monitors} />
          ) : null}
          {metrics.map((metric) => (
            <UsageTag key={metric.id} metric={metric} usage={data.usage} />
          ))}
        </TagLine>
      ) : null}
      {custom ? (
        // Git changes remain actionable; branch and worktree are technical context.
        <TagLine
          testId="statusbar-custom"
          maxLines={1}
          panelSide="top"
          className="session-statusbar"
        >
          {data.git ? (
            <GitStatusButton id={data.id} git={data.git} fixed />
          ) : null}
        </TagLine>
      ) : null}
    </div>
  )
}
