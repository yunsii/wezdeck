// Session optimistic overlay store + per-key FIFO write queue for Web Console.
//
// Keeping a fingerprinted overlay per session id lets read hooks project the
// intended state across detail, list, and tab badges at 0ms while reconciling
// after query commits across both surfaces — never tearing a stale detail or
// list cache back into view, never swallowing a brand-new prompt — and rolling
// back cleanly on error or timeout.
import { useSyncExternalStore } from 'react'

import { trace } from './client-trace'
import {
  SESSION_CLEAR_TTL_MS,
  SESSION_INTERRUPT_TTL_MS,
  SESSION_PROMPT_TTL_MS,
  SESSION_SEND_TTL_MS,
  isDistinctNewPrompt,
  isSessionCardOverlaySettled,
  isSessionDetailOverlaySettled,
  promptFingerprint,
} from './optimistic-state-project'
import type {
  OptimisticTimeoutEvent,
  SessionOptimistic,
} from './optimistic-state-project'
import type { SessionCard } from '#/features/session-card'
import type { Detail } from '#/features/session-detail-types'

export {
  SESSION_CLEAR_TTL_MS,
  SESSION_INTERRUPT_TTL_MS,
  SESSION_PROMPT_TTL_MS,
  SESSION_SEND_TTL_MS,
  applySessionDetailOverlay,
  applySessionsListOverlay,
  isDistinctNewPrompt,
  isSessionCardOverlaySettled,
  isSessionDetailOverlaySettled,
  promptFingerprint,
} from './optimistic-state-project'
export type {
  OptimisticTimeoutEvent,
  SessionOptimistic,
  SessionOptimisticKind,
} from './optimistic-state-project'
export { createSerialQueue } from './serial-queue'

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
      const alreadyConfirmed = Boolean(
        current.settledOn?.detail || current.settledOn?.list,
      )
      sessionOverlays.delete(id)
      sessionTimers.delete(id)
      trace('optimistic', {
        scope: 'session',
        id,
        op_id: opId,
        action: current.kind,
        event: alreadyConfirmed ? 'settle' : 'timeout',
        latency_ms: Date.now() - current.createdAt,
      })
      emit()
      if (!alreadyConfirmed) {
        notifyOptimisticTimeout({
          scope: 'session',
          id,
          opId,
          kind: current.kind,
        })
      }
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

export function reconcileSessionDetail(
  id: string,
  server: Detail | undefined,
  now = Date.now(),
  other?: { listRow?: SessionCard },
) {
  if (!server) return
  const overlay = sessionOverlays.get(id)
  if (!overlay) return
  const state = isSessionDetailOverlaySettled(overlay, server, now)
  if (state === 'active') return
  const serverPrompt = promptFingerprint(server)
  const hardSettle =
    Boolean(server.read_only) ||
    isDistinctNewPrompt(
      overlay.suppressedPromptKey,
      serverPrompt,
      server.waiting_kind,
      overlay.baseline.waitingKind,
    )
  if (
    state === 'settled' &&
    !hardSettle &&
    other?.listRow &&
    !overlay.settledOn?.list &&
    isSessionCardOverlaySettled(overlay, other.listRow, now) === 'active'
  ) {
    if (!overlay.settledOn?.detail) {
      sessionOverlays.set(id, {
        ...overlay,
        settledOn: { ...overlay.settledOn, detail: true },
      })
      emit()
    }
    return
  }
  const alreadyConfirmed = Boolean(
    overlay.settledOn?.detail || overlay.settledOn?.list,
  )
  const isTimeout = state === 'timeout' && !alreadyConfirmed
  clearSessionTimer(id)
  sessionOverlays.delete(id)
  trace('optimistic', {
    scope: 'session',
    id,
    op_id: overlay.opId,
    action: overlay.kind,
    event: isTimeout ? 'timeout' : 'settle',
    latency_ms: now - overlay.createdAt,
  })
  emit()
  if (isTimeout) {
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
  other?: { getDetail?: (id: string) => Detail | undefined },
) {
  if (!rows?.length || sessionOverlays.size === 0) return
  let changed = false
  for (const row of rows) {
    const overlay = sessionOverlays.get(row.id)
    if (!overlay) continue
    const state = isSessionCardOverlaySettled(overlay, row, now)
    if (state === 'active') continue
    const cachedDetail = other?.getDetail?.(row.id)
    if (
      state === 'settled' &&
      cachedDetail &&
      !overlay.settledOn?.detail &&
      isSessionDetailOverlaySettled(overlay, cachedDetail, now) === 'active'
    ) {
      if (!overlay.settledOn?.list) {
        sessionOverlays.set(row.id, {
          ...overlay,
          settledOn: { ...overlay.settledOn, list: true },
        })
        changed = true
      }
      continue
    }
    const alreadyConfirmed = Boolean(
      overlay.settledOn?.detail || overlay.settledOn?.list,
    )
    const isTimeout = state === 'timeout' && !alreadyConfirmed
    clearSessionTimer(row.id)
    sessionOverlays.delete(row.id)
    changed = true
    trace('optimistic', {
      scope: 'session',
      id: row.id,
      op_id: overlay.opId,
      action: overlay.kind,
      event: isTimeout ? 'timeout' : 'settle',
      via: 'list',
      latency_ms: now - overlay.createdAt,
    })
    if (isTimeout) {
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
