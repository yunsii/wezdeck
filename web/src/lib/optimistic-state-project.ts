// Pure session optimistic overlay types, prompt fingerprinting, settlement
// predicates, and read-time detail / list projections (split from
// optimistic-state.ts to keep the store and pure projections focused).
import type { SessionCard } from '#/features/session-card'
import type { Detail } from '#/features/session-detail-types'

export const SESSION_SEND_TTL_MS = 15_000
export const SESSION_PROMPT_TTL_MS = 15_000
export const SESSION_CLEAR_TTL_MS = 10_000
export const SESSION_INTERRUPT_TTL_MS = 10_000

export type SessionOptimisticKind =
  'send' | 'prompt-submit' | 'prompt-cancel' | 'clear' | 'interrupt'

export type SessionOptimistic = {
  id: string
  opId: string
  kind: SessionOptimisticKind
  phase: 'in-flight' | 'settling'
  createdAt: number
  acceptedAt?: number
  ttlMs: number
  /** User text for immediate list preview on optimistic send */
  promptText?: string
  /** Prompt fingerprint suppressed by this or a just-preceding prompt action */
  suppressedPromptKey?: string
  /** Which query surfaces have already observed the settled server state */
  settledOn?: { detail?: boolean; list?: boolean }
  baseline: {
    status?: string
    ts?: number
    waitingKind?: string
    promptKey?: string
    transcriptEnd?: number
  }
}

export type OptimisticTimeoutEvent = {
  scope: 'session' | 'ticket'
  id: string
  opId: string
  kind: string
}

/**
 * Stable fingerprint of the interactive prompt card currently shown by a
 * session detail payload. Matches the exact gating of PromptPanels.
 * Returns '' when no prompt panel is active.
 */
export function promptFingerprint(
  data?: Pick<
    Detail,
    | 'agent'
    | 'status'
    | 'waiting_kind'
    | 'elicitation'
    | 'plan'
    | 'permission'
    | 'screen'
  >,
): string {
  if (!data) return ''
  const waiting = data.status === 'waiting' || Boolean(data.waiting_kind)
  if (waiting && data.elicitation?.questions.length) {
    const first = data.elicitation.questions[0]?.question.slice(0, 64) ?? ''
    return `ask:${data.elicitation.tool_call_id ?? ''}:${data.elicitation.questions.length}:${first}`
  }
  if (waiting && data.plan?.awaiting_approval) {
    return `plan:${(data.plan.excerpt ?? '').slice(0, 128)}`
  }
  if (data.permission) {
    return `perm:${data.agent ?? ''}:${data.permission.tool}:${data.permission.text}:${(data.permission.summary ?? '').slice(0, 128)}`
  }
  if (data.waiting_kind) {
    return `keys:${data.waiting_kind}`
  }
  return ''
}

/**
 * True when `serverPrompt` represents a genuinely new prompt distinct from the
 * one the user just answered (`suppressedKey`). A bare `keys:` downgrade with
 * the same `waiting_kind` (tool result landed in transcript slightly before the
 * attention hook cleared `waiting_kind`) is teardown of the SAME prompt, not a
 * new prompt, so it must stay suppressed instead of flashing the raw key strip.
 */
export function isDistinctNewPrompt(
  suppressedKey: string | undefined,
  serverPrompt: string,
  serverWaitingKind?: string,
  baselineWaitingKind?: string,
): boolean {
  if (!suppressedKey || !serverPrompt || serverPrompt === suppressedKey) {
    return false
  }
  if (
    serverPrompt.startsWith('keys:') &&
    Boolean(serverWaitingKind) &&
    serverWaitingKind === baselineWaitingKind
  ) {
    return false
  }
  return true
}

function isSettlingTimedOut(overlay: SessionOptimistic, now: number): boolean {
  return (
    overlay.phase === 'settling' &&
    overlay.acceptedAt !== undefined &&
    now - overlay.acceptedAt >= overlay.ttlMs
  )
}

export function isSessionDetailOverlaySettled(
  overlay: SessionOptimistic,
  server: Detail,
  now = Date.now(),
): 'active' | 'settled' | 'timeout' {
  if (server.read_only) return 'settled'
  if (isSettlingTimedOut(overlay, now)) return 'timeout'
  const serverPrompt = promptFingerprint(server)
  if (
    isDistinctNewPrompt(
      overlay.suppressedPromptKey,
      serverPrompt,
      server.waiting_kind,
      overlay.baseline.waitingKind,
    )
  ) {
    return 'settled'
  }
  if (overlay.phase === 'in-flight') return 'active'

  const baseTs = overlay.baseline.ts ?? 0
  const serverTs = server.ts ?? 0
  const serverEnd = (server.start ?? 0) + (server.messages?.length ?? 0)
  const serverBusy =
    server.status === 'running' && server.running_kind !== 'background'

  switch (overlay.kind) {
    case 'send': {
      if (
        overlay.suppressedPromptKey &&
        serverPrompt &&
        !isDistinctNewPrompt(
          overlay.suppressedPromptKey,
          serverPrompt,
          server.waiting_kind,
          overlay.baseline.waitingKind,
        )
      ) {
        return 'active'
      }
      if (overlay.baseline.status !== 'running') {
        const done =
          serverBusy ||
          (server.status === 'waiting' &&
            overlay.baseline.status !== 'waiting') ||
          (server.status === 'done' && serverTs > baseTs)
        return done ? 'settled' : 'active'
      }
      const advanced =
        !serverBusy ||
        (overlay.baseline.transcriptEnd !== undefined &&
          serverEnd > overlay.baseline.transcriptEnd)
      return advanced ? 'settled' : 'active'
    }
    case 'prompt-submit':
    case 'prompt-cancel':
      return !serverPrompt &&
        server.status !== 'waiting' &&
        !server.waiting_kind
        ? 'settled'
        : 'active'
    case 'clear':
      return (server.status === 'idle' && !server.waiting_kind) ||
        (serverTs > baseTs && server.status !== overlay.baseline.status)
        ? 'settled'
        : 'active'
    case 'interrupt':
      return !serverBusy || server.interrupted === true ? 'settled' : 'active'
  }
}

export function isSessionCardOverlaySettled(
  overlay: SessionOptimistic,
  row: SessionCard,
  now = Date.now(),
): 'active' | 'settled' | 'timeout' {
  if (isSettlingTimedOut(overlay, now)) return 'timeout'
  if (overlay.phase === 'in-flight') return 'active'

  // SessionCard.ts comes from transcript/window_activity while Detail.ts
  // comes from attention.json e.TS — never compare row.ts vs baseline.ts.
  const rowBusy = row.status === 'running' && row.running_kind !== 'background'

  switch (overlay.kind) {
    case 'send':
      if (overlay.baseline.status !== 'running') {
        const done =
          rowBusy ||
          (row.status === 'waiting' && overlay.baseline.status !== 'waiting') ||
          (row.status === 'done' && row.ts >= overlay.createdAt)
        return done ? 'settled' : 'active'
      }
      return !rowBusy ? 'settled' : 'active'
    case 'prompt-submit':
    case 'prompt-cancel':
      return row.status !== 'waiting' && !row.waiting_kind
        ? 'settled'
        : 'active'
    case 'clear':
      return row.status === 'idle' && !row.waiting_kind ? 'settled' : 'active'
    case 'interrupt':
      return !rowBusy ? 'settled' : 'active'
  }
}

export function applySessionDetailOverlay(
  detail: Detail | undefined,
  overlay: SessionOptimistic | undefined,
  now = Date.now(),
): Detail | undefined {
  if (!detail || !overlay || overlay.settledOn?.detail) return detail
  if (isSessionDetailOverlaySettled(overlay, detail, now) !== 'active') {
    return detail
  }
  const clearedPlan = detail.plan
    ? { ...detail.plan, awaiting_approval: false }
    : undefined
  const clearAllPrompts = {
    waiting_kind: undefined,
    permission: undefined,
    elicitation: undefined,
    plan: clearedPlan,
  }
  const serverPrompt = promptFingerprint(detail)
  const suppressPrompt =
    Boolean(overlay.suppressedPromptKey) &&
    Boolean(serverPrompt) &&
    !isDistinctNewPrompt(
      overlay.suppressedPromptKey,
      serverPrompt,
      detail.waiting_kind,
      overlay.baseline.waitingKind,
    )

  switch (overlay.kind) {
    case 'send':
      return {
        ...detail,
        ...(suppressPrompt ? clearAllPrompts : {}),
        status: 'running',
        running_kind: undefined,
        waiting_kind: undefined,
        interrupted: false,
        turn_started:
          detail.status === 'running' && detail.turn_started
            ? detail.turn_started
            : overlay.createdAt,
      }
    case 'prompt-submit':
      return {
        ...detail,
        ...clearAllPrompts,
        status: 'running',
        running_kind: undefined,
        interrupted: false,
        turn_started: overlay.createdAt,
      }
    case 'prompt-cancel':
      return {
        ...detail,
        ...clearAllPrompts,
        status: 'idle',
        running_kind: undefined,
      }
    case 'clear':
      return {
        ...detail,
        status: 'idle',
        running_kind: undefined,
        waiting_kind: undefined,
      }
    case 'interrupt':
      return {
        ...detail,
        status: 'idle',
        running_kind: undefined,
        interrupted: true,
      }
  }
}

export function applySessionsListOverlay<
  T extends { sessions: Array<SessionCard> },
>(
  reply: T,
  overlays: ReadonlyMap<string, SessionOptimistic>,
  now = Date.now(),
): T {
  if (overlays.size === 0 || reply.sessions.length === 0) return reply
  let changed = false
  const sessions: Array<SessionCard> = []
  for (const row of reply.sessions) {
    const overlay = overlays.get(row.id)
    if (
      !overlay ||
      overlay.settledOn?.list ||
      isSessionCardOverlaySettled(overlay, row, now) !== 'active'
    ) {
      sessions.push(row)
      continue
    }
    changed = true
    if (overlay.kind === 'send' || overlay.kind === 'prompt-submit') {
      sessions.push({
        ...row,
        status: 'running',
        running_kind: undefined,
        waiting_kind: undefined,
        last_prompt:
          overlay.kind === 'send'
            ? overlay.promptText || row.last_prompt
            : row.last_prompt,
        ts: Math.max(row.ts, overlay.createdAt),
      })
    } else {
      sessions.push({
        ...row,
        status: 'idle',
        running_kind: undefined,
        waiting_kind: undefined,
      })
    }
  }
  return changed ? { ...reply, sessions } : reply
}
