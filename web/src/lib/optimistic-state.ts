// Session optimistic overlay store + per-key FIFO write queue for Web Console.
//
// Keeping a fingerprinted overlay per session id lets read hooks project the
// intended state across detail, list, and tab badges at 0ms while reconciling
// naturally the moment server state moves past the baseline fingerprint — never
// swallowing a brand-new prompt — and rolling back cleanly on error or timeout.
import { useSyncExternalStore } from 'react'

import { trace } from './client-trace'
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

type TimeoutListener = (event: OptimisticTimeoutEvent) => void

const timeoutListeners = new Set<TimeoutListener>()

export function onOptimisticTimeout(listener: TimeoutListener) {
  timeoutListeners.add(listener)
  return () => {
    timeoutListeners.delete(listener)
  }
}

export function notifyOptimisticTimeout(event: OptimisticTimeoutEvent) {
  for (const listener of timeoutListeners) listener(event)
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
    return `keys:${data.waiting_kind}:${(data.screen ?? '').slice(-200)}`
  }
  return ''
}

const sessionOverlays = new Map<string, SessionOptimistic>()
const sessionTimers = new Map<string, ReturnType<typeof setTimeout>>()
const listeners = new Set<() => void>()
let sessionSnapshot: ReadonlyMap<string, SessionOptimistic> = new Map()

function emit() {
  sessionSnapshot = new Map(sessionOverlays)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function clearSessionTimer(id: string) {
  const existing = sessionTimers.get(id)
  if (existing !== undefined) {
    clearTimeout(existing)
    sessionTimers.delete(id)
  }
}

function scheduleSessionTimeout(id: string, opId: string, ttlMs: number) {
  clearSessionTimer(id)
  sessionTimers.set(
    id,
    setTimeout(() => {
      const current = sessionOverlays.get(id)
      if (!current || current.opId !== opId) return
      sessionOverlays.delete(id)
      sessionTimers.delete(id)
      trace('optimistic', {
        scope: 'session',
        id,
        op_id: opId,
        action: current.kind,
        event: 'timeout',
        latency_ms: Date.now() - current.createdAt,
      })
      emit()
      notifyOptimisticTimeout({
        scope: 'session',
        id,
        opId,
        kind: current.kind,
      })
    }, ttlMs),
  )
}

export function applySessionOptimistic(
  entry: Omit<SessionOptimistic, 'phase' | 'createdAt' | 'ttlMs'> & {
    createdAt?: number
    ttlMs?: number
  },
) {
  const createdAt = entry.createdAt ?? Date.now()
  const prev = sessionOverlays.get(entry.id)
  const defaultTtl =
    entry.kind === 'send'
      ? SESSION_SEND_TTL_MS
      : entry.kind === 'clear'
        ? SESSION_CLEAR_TTL_MS
        : entry.kind === 'interrupt'
          ? SESSION_INTERRUPT_TTL_MS
          : SESSION_PROMPT_TTL_MS
  const suppressedPromptKey =
    entry.suppressedPromptKey ??
    entry.baseline.promptKey ??
    (entry.kind === 'send' ? prev?.suppressedPromptKey : undefined)
  clearSessionTimer(entry.id)
  sessionOverlays.set(entry.id, {
    ...entry,
    suppressedPromptKey,
    phase: 'in-flight',
    createdAt,
    ttlMs: entry.ttlMs ?? defaultTtl,
  })
  trace('optimistic', {
    scope: 'session',
    id: entry.id,
    op_id: entry.opId,
    action: entry.kind,
    event: 'apply',
  })
  emit()
}

export function acceptSessionOptimistic(
  id: string,
  opId: string,
  now = Date.now(),
) {
  const current = sessionOverlays.get(id)
  if (!current || current.opId !== opId) return
  sessionOverlays.set(id, { ...current, phase: 'settling', acceptedAt: now })
  scheduleSessionTimeout(id, opId, current.ttlMs)
  emit()
}

export function rollbackSessionOptimistic(
  id: string,
  opId: string,
  reason?: string,
) {
  const current = sessionOverlays.get(id)
  if (!current || current.opId !== opId) return
  clearSessionTimer(id)
  sessionOverlays.delete(id)
  trace('optimistic', {
    scope: 'session',
    id,
    op_id: opId,
    action: current.kind,
    event: 'rollback',
    reason: reason ?? null,
    latency_ms: Date.now() - current.createdAt,
  })
  emit()
}

export function transferSessionOptimistic(fromId: string, toId: string) {
  if (!fromId || !toId || fromId === toId) return
  const current = sessionOverlays.get(fromId)
  if (!current) return
  clearSessionTimer(fromId)
  sessionOverlays.delete(fromId)
  const moved: SessionOptimistic = { ...current, id: toId }
  sessionOverlays.set(toId, moved)
  if (moved.phase === 'settling' && moved.acceptedAt !== undefined) {
    const left = Math.max(0, moved.ttlMs - (Date.now() - moved.acceptedAt))
    scheduleSessionTimeout(toId, moved.opId, left)
  }
  emit()
}

export function isSessionDetailOverlaySettled(
  overlay: SessionOptimistic,
  server: Detail,
  now = Date.now(),
): 'active' | 'settled' | 'timeout' {
  if (server.read_only) return 'settled'
  if (
    overlay.phase === 'settling' &&
    overlay.acceptedAt !== undefined &&
    now - overlay.acceptedAt >= overlay.ttlMs
  ) {
    return 'timeout'
  }
  const serverPrompt = promptFingerprint(server)
  if (
    overlay.suppressedPromptKey &&
    serverPrompt &&
    serverPrompt !== overlay.suppressedPromptKey
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
        serverPrompt === overlay.suppressedPromptKey
      ) {
        return 'active'
      }
      if (overlay.baseline.status !== 'running') {
        return serverBusy || serverTs > baseTs ? 'settled' : 'active'
      }
      if (
        serverTs > baseTs ||
        !serverBusy ||
        (overlay.baseline.transcriptEnd !== undefined &&
          serverEnd > overlay.baseline.transcriptEnd)
      ) {
        return 'settled'
      }
      return 'active'
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
        serverTs > baseTs
        ? 'settled'
        : 'active'
    case 'interrupt':
      return !serverBusy || server.interrupted === true || serverTs > baseTs
        ? 'settled'
        : 'active'
  }
}

export function isSessionCardOverlaySettled(
  overlay: SessionOptimistic,
  row: SessionCard,
  now = Date.now(),
): 'active' | 'settled' | 'timeout' {
  if (
    overlay.phase === 'settling' &&
    overlay.acceptedAt !== undefined &&
    now - overlay.acceptedAt >= overlay.ttlMs
  ) {
    return 'timeout'
  }
  if (overlay.phase === 'in-flight') return 'active'

  const baseTs = overlay.baseline.ts ?? 0
  const rowTs = row.ts
  const rowBusy = row.status === 'running' && row.running_kind !== 'background'

  switch (overlay.kind) {
    case 'send':
      if (overlay.baseline.status !== 'running') {
        return rowBusy || rowTs > baseTs ? 'settled' : 'active'
      }
      return rowTs > baseTs || !rowBusy ? 'settled' : 'active'
    case 'prompt-submit':
    case 'prompt-cancel':
      return (row.status !== 'waiting' && !row.waiting_kind) || rowTs > baseTs
        ? 'settled'
        : 'active'
    case 'clear':
      return (row.status === 'idle' && !row.waiting_kind) || rowTs > baseTs
        ? 'settled'
        : 'active'
    case 'interrupt':
      return !rowBusy || rowTs > baseTs ? 'settled' : 'active'
  }
}

export function reconcileSessionDetail(
  id: string,
  server: Detail | undefined,
  now = Date.now(),
) {
  if (!server) return
  const overlay = sessionOverlays.get(id)
  if (!overlay) return
  const state = isSessionDetailOverlaySettled(overlay, server, now)
  if (state === 'active') return
  clearSessionTimer(id)
  sessionOverlays.delete(id)
  trace('optimistic', {
    scope: 'session',
    id,
    op_id: overlay.opId,
    action: overlay.kind,
    event: state === 'settled' ? 'settle' : 'timeout',
    latency_ms: now - overlay.createdAt,
  })
  emit()
  if (state === 'timeout') {
    notifyOptimisticTimeout({
      scope: 'session',
      id,
      opId: overlay.opId,
      kind: overlay.kind,
    })
  }
}

export function reconcileSessionsList(
  rows: ReadonlyArray<SessionCard> | undefined,
  now = Date.now(),
) {
  if (!rows?.length || sessionOverlays.size === 0) return
  let changed = false
  for (const row of rows) {
    const overlay = sessionOverlays.get(row.id)
    if (!overlay) continue
    const state = isSessionCardOverlaySettled(overlay, row, now)
    if (state === 'active') continue
    clearSessionTimer(row.id)
    sessionOverlays.delete(row.id)
    changed = true
    trace('optimistic', {
      scope: 'session',
      id: row.id,
      op_id: overlay.opId,
      action: overlay.kind,
      event: state === 'settled' ? 'settle' : 'timeout',
      via: 'list',
      latency_ms: now - overlay.createdAt,
    })
    if (state === 'timeout') {
      notifyOptimisticTimeout({
        scope: 'session',
        id: row.id,
        opId: overlay.opId,
        kind: overlay.kind,
      })
    }
  }
  if (changed) emit()
}

export function applySessionDetailOverlay(
  detail: Detail | undefined,
  overlay: SessionOptimistic | undefined,
  now = Date.now(),
): Detail | undefined {
  if (!detail || !overlay) return detail
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
    serverPrompt === overlay.suppressedPromptKey

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

export { createSerialQueue } from './serial-queue'

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

export function useAllSessionOptimistics() {
  return useSyncExternalStore(
    subscribe,
    () => sessionSnapshot,
    () => sessionSnapshot,
  )
}

export function useSessionOptimistic(id: string) {
  return useAllSessionOptimistics().get(id)
}

/** Test helper: clear all session optimistic state and timers. */
export function resetSessionOptimisticForTest() {
  for (const timer of sessionTimers.values()) clearTimeout(timer)
  sessionTimers.clear()
  sessionOverlays.clear()
  emit()
}
