// Shared session detail wire types (re-exported by console-sessions.tsx).
import type { GitStatus } from '#/components/deck/session-tags'
import type { TokenRate } from '#/lib/turn-progress'
import type { Message } from './chat-thread'
import type { SentRecord } from './sent-history-data'
import type { BgTask } from './session-background'
import type { Elicitation } from './session-elicitation'
import type { PendingCall } from './session-permission'
import type { StatusFields } from './session-statusbar'
import type { Subagent } from './session-subagents'

export type Usage = {
  model?: string
  context: number
  context_limit: number
  /** compacted since the last reply: `context` is unknown until the next one */
  context_pending?: boolean
  turns: number
  output: number
  input: number
  cache_read: number
}

export type RateWindow = { used_percentage: number; resets_at?: number }

/** the Claude account's limits as Claude Code last reported them (remote_limits.go) */
export type AccountLimits = {
  five_hour?: RateWindow
  seven_day?: RateWindow
  at: number
}

/** What the phone may offer for this agent (host agent_adapter.go agentCaps). */
export type AgentCapabilities = {
  ask_options: boolean
  plan_review: boolean
  usage: 'transcript' | 'token_count' | 'none'
  account_limits: boolean
  mid_turn_input: 'queue' | 'steer'
  title: boolean
}

export type TitleHistoryItem = {
  title: string
  at: number
  ended_at?: number
  user_turns?: number
  source?: 'auto' | 'manual' | 'native'
  provider?: string
}

export type Detail = StatusFields & {
  interrupted?: boolean
  messages_rev?: number
  read_only?: boolean
  can_recover?: boolean
  id: string
  name?: string
  title?: string
  /** chronological task titles recorded for this session (session_autotitle.go) */
  title_history?: Array<TitleHistoryItem>
  window?: string
  branch?: string
  /** working-tree status of the pane's cwd (git_status.go) */
  git?: GitStatus
  usage?: Usage
  account?: AccountLimits
  /** host-built block an agent can act on (remote_reference.go) */
  reference?: string
  capabilities?: AgentCapabilities
  /** everything the host knows, grouped (remote_meta.go) */
  meta?: Array<{ name: string; rows: Array<{ key: string; value: string }> }>
  total?: number
  start?: number
  /** Claude subagents (Agent tool, forked skills) and what they are doing */
  subagents?: Array<Subagent>
  /** index of the latest context-compaction marker; earlier = pre-compaction history */
  compacted_at?: number
  compactions?: number
  agent?: string
  /** execution / permission mode (auto | accept-edits | plan | full-access | default …) */
  mode?: string
  status: string
  /** the attention entry's last change (ms): seen-ack clears this state only */
  ts?: number
  waiting_kind?: string
  running_kind?: string
  background?: Array<BgTask>
  messages?: Array<Message>
  screen?: string
  /** ms: when the running turn began (attention turn_started) */
  turn_started?: number
  /** ms: when the running context compaction began */
  compact_started?: number
  /** output tokens of the running turn (transcript usage) */
  turn_output?: number
  /** host-side token output rate (OTel primary, transcript fallback) */
  token_rate?: TokenRate
  elicitation?: Elicitation
  plan?: { excerpt?: string; awaiting_approval?: boolean }
  /** a permission prompt: the call it is about (host permission.go) */
  permission?: PendingCall
  /** cleared in its pane (/new, /clear): the session that took its place */
  replaced_by?: string
  /** the local Runtime's sessions/focus payload (在终端中打开, session-focus.tsx) */
  focus?: { session_id: string; recent?: boolean; archived_ts?: number }
  /** host-persisted unsettled sent messages for this session (remote_outbox.go) */
  outbox?: Array<SentRecord>
  /** Browser time when the detail request carrying this outbox began. */
  outboxReadStartedAt?: number
}
