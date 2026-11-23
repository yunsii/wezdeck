// 会话信息: everything the host knows about a session (the `meta` groups from
// remote_meta.go, plus usage, account limits and the agent's capabilities),
// in a bottom sheet opened from the header's ⓘ. Tap a row to copy its value;
// 复制引用 copies the agent-ready block (remote_reference.go). Esc, the
// backdrop or × closes it. Portalled to <body>: the header's backdrop blur
// would otherwise become the containing block of a fixed sheet.
import { useLingui } from '@lingui/react/macro'
import { Check, Code2, Copy, Pencil } from 'lucide-react'
import { useState } from 'react'

import { useStatusText } from './console-sessions'
import type { Detail } from './console-sessions'
import { ClearButton } from './session-clear'
import { Button } from '#/components/ui/button'
import { Sheet } from '#/components/ui/sheet'
import { SectionHeading } from '#/components/ui/section-heading'
import { Field, FieldList } from '#/components/ui/field'
import { copyText } from '#/lib/clipboard'
import { postRuntimeAction } from '#/lib/runtime-client'
import { toast } from 'sonner'
import { useConsoleMode } from './console-mode'

export type MetaGroup = {
  name: string
  rows: Array<{ key: string; value: string }>
}

function useLabels() {
  const { t } = useLingui()
  const groups: Record<string, string> = {
    session: t`Session`,
    location: t`Where it runs`,
    transcript: t`Transcript`,
    state: t`State`,
    usage: t`Usage`,
    capabilities: t`Capabilities`,
  }
  const keys: Record<string, string> = {
    id: t`Session id`,
    agent: 'Agent',
    title: t`Title`,
    agent_name: t`Agent name`,
    window: t`tmux window`,
    model: t`Model`,
    cwd: t`Directory`,
    repo: t`Repository`,
    repo_root: t`Repository root`,
    worktree: t`Worktree`,
    branch: t`Branch`,
    tmux_socket: 'tmux socket',
    tmux_session: t`tmux session`,
    tmux_pane: t`tmux pane`,
    pane_role: t`Pane role`,
    pane_command: t`Running in pane`,
    pane: t`Pane`,
    path: t`File`,
    bytes: t`Size`,
    modified: t`Modified`,
    messages: t`Messages`,
    loaded: t`Loaded on this page`,
    compactions: t`Context compactions`,
    first_turn: t`First turn`,
    last_turn: t`Last turn`,
    status: t`Status`,
    reason: t`Reason`,
    running_kind: t`Running substate`,
    waiting_kind: t`Waiting for`,
    status_updated: t`Status updated`,
    desk_idle: t`Desk idle for`,
    background_tasks: t`Background tasks`,
    context: t`Context`,
    output: t`Output tokens`,
    cache_hit: t`Cache hit`,
    five_hour: t`5-hour limit`,
    seven_day: t`7-day limit`,
    ask_options: t`Tappable Ask options`,
    plan_review: t`Plan review`,
    usage_source: t`Usage from`,
    account_limits: t`Account limits`,
    mid_turn_input: t`A message sent mid-turn`,
    names_sessions: t`Names sessions`,
  }
  const yes = t`yes`
  const no = t`no`
  return { groups, keys, yes, no }
}

const TIME_KEYS = new Set([
  'modified',
  'first_turn',
  'last_turn',
  'status_updated',
])

function format(key: string, value: string) {
  if (TIME_KEYS.has(key)) {
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) return date.toLocaleString()
  }
  if (key === 'bytes') {
    const n = Number(value)
    if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
    if (n >= 1024) return `${Math.round(n / 1024)} KB`
  }
  return value
}

/** usage / account / capabilities, which travel outside `meta`, as rows */
function extraGroups(
  data: Detail,
  yes: string,
  no: string,
  steer: string,
  queue: string,
) {
  const groups: Array<MetaGroup> = []
  const u = data.usage
  const usage: MetaGroup = { name: 'usage', rows: [] }
  if (u?.context_limit)
    usage.rows.push({
      key: 'context',
      value: `${u.context.toLocaleString()} / ${u.context_limit.toLocaleString()} (${Math.round((u.context / u.context_limit) * 100)}%)`,
    })
  if (u?.output)
    usage.rows.push({ key: 'output', value: u.output.toLocaleString() })
  if (u && u.input + u.cache_read)
    usage.rows.push({
      key: 'cache_hit',
      value: `${Math.round((u.cache_read / (u.input + u.cache_read)) * 100)}%`,
    })
  const a = data.account
  if (a?.five_hour)
    usage.rows.push({
      key: 'five_hour',
      value: `${a.five_hour.used_percentage}%`,
    })
  if (a?.seven_day)
    usage.rows.push({
      key: 'seven_day',
      value: `${a.seven_day.used_percentage}%`,
    })
  if (usage.rows.length) groups.push(usage)
  const c = data.capabilities
  if (c)
    groups.push({
      name: 'capabilities',
      rows: [
        { key: 'ask_options', value: c.ask_options ? yes : no },
        { key: 'plan_review', value: c.plan_review ? yes : no },
        { key: 'usage_source', value: c.usage },
        { key: 'account_limits', value: c.account_limits ? yes : no },
        {
          key: 'mid_turn_input',
          value: c.mid_turn_input === 'steer' ? steer : queue,
        },
        { key: 'names_sessions', value: c.title ? yes : no },
      ],
    })
  return groups
}

export function SessionInfo({
  data,
  open,
  onClose,
  onRename,
  renameDisabled,
}: {
  data: Detail
  open: boolean
  onClose: () => void
  /** paste `/rename <title>` into the agent TUI (Claude and Grok honor it) */
  onRename?: (title: string) => void
  renameDisabled?: boolean
}) {
  // t must come straight from useLingui() here: a t handed out of another
  // hook is not a macro any more and renders empty strings
  const { t } = useLingui()
  const { groups: groupLabels, keys, yes, no } = useLabels()
  const statusText = useStatusText()
  const [copiedRef, setCopiedRef] = useState(false)
  // stays mounted while closed: the sheet plays its exit before it unmounts
  if (typeof document === 'undefined') return null
  const loaded = {
    key: 'loaded',
    value: `${data.messages?.length ?? 0} / ${data.total ?? data.messages?.length ?? 0}`,
  }
  const groups = [
    ...(data.meta ?? []).map((group) =>
      group.name === 'transcript'
        ? { ...group, rows: [...group.rows, loaded] }
        : group,
    ),
    ...extraGroups(data, yes, no, t`joins the current turn`, t`is queued`),
  ]
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      title={t`Session info`}
      testId="session-info"
    >
      <div className="grid gap-3 px-3">
        {data.reference ? (
          <Button
            variant="solid"
            type="button"
            onClick={() => {
              void copyText(data.reference ?? '').then(() => {
                setCopiedRef(true)
                setTimeout(() => setCopiedRef(false), 1_500)
              })
            }}
            className="flex min-h-11 items-center justify-center gap-2 px-3 text-body font-medium"
          >
            {copiedRef ? (
              <Check size={16} aria-hidden />
            ) : (
              <Copy size={16} aria-hidden />
            )}
            {copiedRef ? t`Copied` : t`Copy session reference for an agent`}
          </Button>
        ) : null}
        <ClearButton
          id={data.id}
          status={data.status}
          waitingKind={data.waiting_kind}
        />
        {onRename ? (
          <Button
            variant="plain"
            type="button"
            data-write
            disabled={renameDisabled}
            onClick={() => {
              const title = data.title || ''
              const next = window.prompt(t`New session title`, title)?.trim()
              if (next && next !== title) onRename(next)
            }}
            className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-brand-edge px-3 text-body font-medium disabled:opacity-40"
          >
            <Pencil size={15} aria-hidden />
            {t`Rename via /rename in the agent pane`}
          </Button>
        ) : null}
        <OpenInVsCode cwd={metaValue(data, 'cwd')} />
        <p className="px-1 text-meta text-brand-label">
          {t`Tap a row to copy its value; long-press or right-click for more.`}
        </p>
        {groups.map((group) => (
          <section key={group.name} className="grid gap-1">
            <SectionHeading className="bg-brand-deck">
              {groupLabels[group.name] ?? group.name}
            </SectionHeading>
            <FieldList>
              {group.rows.map((row) => (
                <Field
                  key={row.key}
                  label={keys[row.key] ?? row.key}
                  // the state in words, as on the list (it showed the raw
                  // `done`); the kinds below stay raw for debugging
                  value={
                    row.key === 'status'
                      ? statusText(
                          row.value,
                          data.waiting_kind,
                          data.running_kind,
                          data.background?.length ?? 0,
                        )
                      : format(row.key, row.value)
                  }
                  mono
                />
              ))}
            </FieldList>
          </section>
        ))}
      </div>
    </Sheet>
  )
}

export function metaValue(data: Detail, key: string) {
  for (const group of data.meta ?? [])
    for (const row of group.rows) if (row.key === key) return row.value
  return ''
}

/**
 * 在 VS Code 中打开 — what was left worth keeping of the old 开发 page. Only
 * on this computer: it asks the local Runtime to focus the window for the
 * session's directory, or open one.
 */
function OpenInVsCode({ cwd }: { cwd: string }) {
  const { t } = useLingui()
  const mode = useConsoleMode()
  const [busy, setBusy] = useState(false)
  if (mode !== 'local' || !cwd) return null
  const open = async () => {
    setBusy(true)
    try {
      const response = await postRuntimeAction('vscode', 'focus_or_open', {
        requested_dir: cwd,
        distro: 'Ubuntu',
      })
      if (!response.ok)
        throw new Error(response.error?.message || t`Runtime action failed`)
      toast(t`VS Code window focused`)
    } catch (error) {
      toast(error instanceof Error ? error.message : t`Runtime action failed`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button
      variant="plain"
      type="button"
      disabled={busy}
      onClick={() => void open()}
      className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-brand-edge px-3 text-body font-medium disabled:opacity-40"
    >
      <Code2 size={15} aria-hidden />
      {t`Open in VS Code`}
    </Button>
  )
}
