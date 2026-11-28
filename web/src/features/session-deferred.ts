import type { Pending } from './chat-pending'

export type DeferredRecord = {
  id: string
  client_op: string
  session_id: string
  pane: string
  worktree: string
  text: string
  attachments?: Array<string>
  policy: 'after_turn' | 'after_review'
  status: 'queued' | 'waiting_review' | 'releasing' | 'failed' | 'stale'
  created_at: number
  armed_at?: number
  error?: string
}

export function mergeDeferredPending(
  local: Array<Pending>,
  host?: Array<DeferredRecord>,
  dismissed?: ReadonlySet<string>,
  readStartedAt?: number,
): Array<Pending> {
  if (!host) return local
  const visible = host.filter((item) => !dismissed?.has(item.id))
  const ids = new Set(visible.map((item) => item.id))
  const ops = new Set(visible.map((item) => item.client_op))
  const optimistic = local.filter(
    (item) =>
      (!item.deferredId ||
        (item.acceptedAt !== undefined &&
          (readStartedAt ?? 0) <= item.acceptedAt)) &&
      (!item.deferredId || !ids.has(item.deferredId)) &&
      (!item.clientOp || !ops.has(item.clientOp)),
  )
  const records: Array<Pending> = visible.map((item) => ({
    text: item.text,
    attachments: item.attachments ?? [],
    at: item.created_at,
    clientOp: item.client_op,
    deferredId: item.id,
    deferredStatus: item.status,
    deferredArmedAt: item.armed_at,
    error: item.error,
    state:
      item.status === 'waiting_review'
        ? 'waiting_review'
        : item.status === 'failed' || item.status === 'stale'
          ? 'failed'
          : 'deferred',
  }))
  return [...optimistic, ...records].sort((a, b) => a.at - b.at)
}
