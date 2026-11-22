// 会话信息: everything the host knows about a session (the `meta` groups from
// remote_meta.go, plus usage, account limits and the agent's capabilities),
// in a bottom sheet opened from the header's ⓘ. Tap a row to copy its value;
// 复制引用 copies the agent-ready block (remote_reference.go). Esc, the
// backdrop or × closes it. Portalled to <body>: the header's backdrop blur
// would otherwise become the containing block of a fixed sheet.
import { useLingui } from '@lingui/react/macro'
import { Check, Copy, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import type { Detail } from './console-sessions'

export type MetaGroup = {
  name: string
  rows: Array<{ key: string; value: string }>
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.style.cssText = 'position:fixed;opacity:0'
    document.body.append(area)
    area.select()
    document.execCommand('copy')
    area.remove()
  }
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

function Row({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        void copyText(value).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1_200)
        })
      }}
      className="grid w-full grid-cols-[7.5rem_minmax(0,1fr)_1rem] items-start gap-2 px-3 py-2 text-left text-[13px] active:bg-brand-deck"
    >
      <span className="text-brand-label">{label}</span>
      <span className="font-mono text-[12px] break-all text-brand-text">
        {value}
      </span>
      <span className="pt-0.5 text-brand-label">
        {copied ? (
          <Check size={13} aria-hidden className="text-brand-done" />
        ) : null}
      </span>
    </button>
  )
}

export function SessionInfo({
  data,
  open,
  onClose,
}: {
  data: Detail
  open: boolean
  onClose: () => void
}) {
  // t must come straight from useLingui() here: a t handed out of another
  // hook is not a macro any more and renders empty strings
  const { t } = useLingui()
  const { groups: groupLabels, keys, yes, no } = useLabels()
  const [copiedRef, setCopiedRef] = useState(false)
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open || typeof document === 'undefined') return null
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
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end bg-black/30"
      onClick={onClose}
      data-deck
    >
      <div
        role="dialog"
        aria-label={t`Session info`}
        data-testid="session-info"
        onClick={(event) => event.stopPropagation()}
        className="max-h-[82dvh] w-full overflow-y-auto rounded-t-[20px] bg-brand-deck pb-[max(env(safe-area-inset-bottom),1rem)] text-brand-text"
      >
        <div className="sticky top-0 flex items-center justify-between gap-2 bg-brand-deck px-4 pt-3 pb-2">
          <h2 className="text-[16px] font-semibold">{t`Session info`}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t`Close`}
            className="inline-flex size-9 items-center justify-center rounded-full text-brand-muted"
          >
            <X size={18} aria-hidden />
          </button>
        </div>
        <div className="grid gap-3 px-3">
          {data.reference ? (
            <button
              type="button"
              onClick={() => {
                void copyText(data.reference ?? '').then(() => {
                  setCopiedRef(true)
                  setTimeout(() => setCopiedRef(false), 1_500)
                })
              }}
              className="flex min-h-11 items-center justify-center gap-2 rounded-[12px] bg-brand-text px-3 text-[14px] font-medium text-brand-deck"
            >
              {copiedRef ? (
                <Check size={16} aria-hidden />
              ) : (
                <Copy size={16} aria-hidden />
              )}
              {copiedRef ? t`Copied` : t`Copy session reference for an agent`}
            </button>
          ) : null}
          <p className="px-1 text-[11.5px] text-brand-label">
            {t`Tap a row to copy its value.`}
          </p>
          {groups.map((group) => (
            <section key={group.name} className="grid gap-1">
              <h3 className="px-1 text-[12.5px] font-semibold text-brand-muted">
                {groupLabels[group.name] ?? group.name}
              </h3>
              <div className="overflow-hidden rounded-[14px] bg-brand-surface">
                {group.rows.map((row) => (
                  <Row
                    key={row.key}
                    label={keys[row.key] ?? row.key}
                    value={format(row.key, row.value)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  )
}
