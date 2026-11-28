// Observability for the session list (docs/diagnostics.md, client-trace.ts):
// records list order/membership/status changes and flags rapid re-render bursts
// so "the session list was flickering wildly" leaves concrete evidence in
// `wezdeck-wsl diag` snapshots without storing message text.
import { useEffect, useRef } from 'react'

import { trace } from '#/lib/client-trace'
import type { SessionChat } from './session-chats'

type PaintedRepo = { chats: Array<SessionChat> }

export type ListRowSig = {
  key: string
  status: string
  unread: number
  count: number
}

export type ListDiff = {
  rows: number
  orderChanged: boolean
  added: number
  removed: number
  statusChanged: number
}

/** Flatten painted repo groups into compact row signatures (no text/secrets). */
export function listRowSignatures(
  painted: Array<PaintedRepo>,
): Array<ListRowSig> {
  const out: Array<ListRowSig> = []
  for (const repo of painted) {
    for (const chat of repo.chats) {
      out.push({
        key: chat.focus.pinned_at ? `pin:${chat.focus.id}` : chat.key,
        status: chat.focus.status,
        unread: chat.unread,
        count: chat.sessions.length,
      })
    }
  }
  return out
}

/** Pure diff between two list snapshots for order/membership/status churn. */
export function diffSessionRows(
  prev: Array<ListRowSig>,
  next: Array<ListRowSig>,
): ListDiff {
  const prevMap = new Map(prev.map((row) => [row.key, row]))
  const nextMap = new Map(next.map((row) => [row.key, row]))
  let added = 0
  let removed = 0
  let statusChanged = 0
  for (const row of next) {
    const old = prevMap.get(row.key)
    if (!old) {
      added++
    } else if (
      old.status !== row.status ||
      old.unread !== row.unread ||
      old.count !== row.count
    ) {
      statusChanged++
    }
  }
  for (const row of prev) {
    if (!nextMap.has(row.key)) removed++
  }
  // Check relative order of keys present in both snapshots
  const prevCommon = prev
    .filter((row) => nextMap.has(row.key))
    .map((row) => row.key)
  const nextCommon = next
    .filter((row) => prevMap.has(row.key))
    .map((row) => row.key)
  const orderChanged = prevCommon.some((key, idx) => key !== nextCommon[idx])
  return {
    rows: next.length,
    orderChanged,
    added,
    removed,
    statusChanged,
  }
}

const BURST_WINDOW_MS = 1_000
const BURST_THRESHOLD = 6
const BURST_THROTTLE_MS = 500

export function useSessionListTrace(
  painted: Array<PaintedRepo>,
  selected?: string,
) {
  const prevRef = useRef<Array<ListRowSig> | null>(null)
  const renderTimesRef = useRef<Array<number>>([])
  const lastBurstAtRef = useRef(0)

  const sigs = listRowSignatures(painted)
  useEffect(() => {
    const now =
      typeof performance !== 'undefined' ? performance.now() : Date.now()
    const times = renderTimesRef.current
    times.push(now)
    while (times.length > 0 && now - times[0] > BURST_WINDOW_MS) times.shift()
    const renders1s = times.length

    const prev = prevRef.current
    prevRef.current = sigs
    if (!prev) return

    const diff = diffSessionRows(prev, sigs)
    const changed =
      diff.orderChanged ||
      diff.added > 0 ||
      diff.removed > 0 ||
      diff.statusChanged > 0
    const burst =
      renders1s >= BURST_THRESHOLD &&
      now - lastBurstAtRef.current >= BURST_THROTTLE_MS

    if (changed || burst) {
      if (burst) lastBurstAtRef.current = now
      trace('session-list-diff', {
        ...diff,
        selected: selected ?? '',
        renders1s,
        burst,
      })
    }
  })
}
