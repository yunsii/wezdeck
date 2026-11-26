// The turn line at the foot of the thread: what the agent does now, or how
// long its last turn took — "运行中… 4m 09s · ↓ 19.1k tokens", "正在压缩上下文…
// 36s", then "用时 36s · 13:42 完成" (Claude Code's "Cooked for 36s").
// One row in one place whose text changes: it used to appear only once the
// host said running (a poll after the send) and vanish when the turn ended,
// so the thread jumped twice per turn (docs/web-pwa.md "Layout stability").
// Working shows at once after a send (optimistic), timed from the send,
// until the host's own turn_started takes over.
import { useLingui } from '@lingui/react/macro'
import { useRef } from 'react'

import { Led } from '#/components/deck/led'
import {
  formatElapsed,
  formatTokenRate,
  formatTokens,
  useNow,
} from '#/lib/turn-progress'
import { cn } from '#/lib/utils'
import type { Message, Pending } from './chat-thread'

/** The running turn, from hooks (lib/turn-progress.ts). */
export type Activity = {
  /** ms: when the turn began (attention turn_started) */
  since?: number
  /** ms: when a context compaction began; set only while it runs */
  compactSince?: number
  /** output tokens of the turn so far */
  tokens?: number
  /** effective output rate in tok/s (OTel primary, transcript fallback) */
  rate?: number
}

export type TurnState =
  | { kind: 'working'; activity?: Activity }
  | { kind: 'done'; took?: number; at?: number }

/** a sent message the host has not answered for this long is not "working" */
const STARTING_FOR_MS = 120_000

const parse = (ts?: string) => {
  const ms = ts ? Date.parse(ts) : NaN
  return Number.isFinite(ms) ? ms : undefined
}

/**
 * busy (the host says running) → working with its activity; a message just
 * sent, or the newest transcript line a prompt the host has not flipped to
 * running yet → working from the send; a waiting session → nothing (its
 * question shows below); else the last turn done: from its prompt to its
 * last line, or the entry's last change when the transcript has no times.
 */
export function turnState({
  messages,
  left,
  busy,
  status,
  statusTs,
  activity,
  now = Date.now(),
}: {
  messages: Array<Message>
  /** sent, not in the transcript yet */
  left: Array<Pending>
  busy: boolean
  status?: string
  statusTs?: number
  activity?: Activity
  now?: number
}): TurnState | null {
  if (busy) return { kind: 'working', activity }
  if (status === 'waiting') return null
  const sent = left.at(0)?.at
  if (sent !== undefined) return { kind: 'working', activity: { since: sent } }
  let lastUser = -1
  for (let i = messages.length - 1; i >= 0; i -= 1)
    if (messages[i]?.role === 'user') {
      lastUser = i
      break
    }
  if (lastUser < 0) return null
  const asked = parse(messages[lastUser]?.ts)
  const after = messages.slice(lastUser + 1)
  if (
    after.length === 0 &&
    asked !== undefined &&
    now - asked < STARTING_FOR_MS &&
    (statusTs === undefined || asked > statusTs)
  )
    return { kind: 'working', activity: { since: asked } }
  if (after.length === 0) return null
  const lastTimed = [...after].reverse().find((message) => message.ts)
  const at = parse(lastTimed?.ts) ?? statusTs
  return {
    kind: 'done',
    took: asked !== undefined && at !== undefined ? at - asked : undefined,
    at,
  }
}

/**
 * The turn line while new messages are still being revealed one by one: a
 * turn the host already calls done stays "working" until its last reply is
 * on screen, so 完成 never shows above text still unfolding. The line itself
 * stays mounted throughout (chat-thread.tsx) — it used to unmount during
 * every reveal, vanishing and replaying its entrance each poll of a running
 * turn: a jitter every second or two, and 运行中 gone mid-turn.
 */
export function revealingTurnState(
  state: TurnState | null,
  revealing: boolean,
): TurnState | null {
  if (!revealing || state?.kind !== 'done') return state
  return { kind: 'working' }
}

/** 13:42 today, 11/23 13:42 another day */
function clock(ms: number) {
  const date = new Date(ms)
  const time = date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.toLocaleDateString([], { month: 'numeric', day: 'numeric' })} ${time}`
}

export function TurnLine({ state }: { state: TurnState | null }) {
  const { t } = useLingui()
  const working = state?.kind === 'working' ? state : null
  const activity = working?.activity
  const compacting = activity?.compactSince !== undefined
  const from = activity?.compactSince ?? activity?.since
  const now = useNow(working !== null && from !== undefined)
  // enters only when it appears in an open conversation: switching to a
  // running session mounted it with the thread and slid it in alone
  const absentAtMount = useRef(state === null)
  if (!state) return null
  let label: string
  let detail: string
  if (working) {
    label = compacting ? t`Compacting conversation` : t`Working`
    const tokens =
      !compacting && activity?.tokens ? formatTokens(activity.tokens) : ''
    const rate =
      !compacting && activity?.rate ? formatTokenRate(activity.rate) : ''
    detail = [
      from !== undefined ? formatElapsed(Math.max(0, now - from)) : '',
      tokens ? t`↓ ${tokens} tokens` : '',
      rate,
    ]
      .filter(Boolean)
      .join(' · ')
  } else {
    const done = state as Extract<TurnState, { kind: 'done' }>
    const took =
      done.took !== undefined && done.took >= 0 ? formatElapsed(done.took) : ''
    const when = done.at !== undefined ? clock(done.at) : ''
    label = took ? t`Took ${took}` : t`Done`
    detail = when ? t`done ${when}` : ''
  }
  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-2',
        absentAtMount.current && 'chat-in',
      )}
    >
      <div
        role="status"
        aria-label={detail ? `${label} ${detail}` : label}
        data-activity={
          working ? (compacting ? 'compacting' : 'working') : 'done'
        }
        className="flex min-w-0 flex-1 items-center gap-2 px-1 py-0.5"
      >
        <Led
          tone={working ? (compacting ? 'waiting' : 'running') : 'done'}
          size={9}
          className={working ? 'led-running' : undefined}
        />
        <span className="min-w-0 truncate text-caption text-brand-muted">
          <span className={cn(compacting && 'text-brand-waiting')}>
            {working ? `${label}…` : label}
          </span>
          {detail ? (
            <span data-live className="ml-1.5 text-brand-label tabular-nums">
              {working ? detail : `· ${detail}`}
            </span>
          ) : null}
        </span>
      </div>
    </div>
  )
}
