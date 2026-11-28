import { refusal } from './remote-auth'
import { recordRpcTiming } from './remote-link-trace'

export type Pending = {
  action: string
  startedAt: number
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export function settleRemoteReply(
  frame: {
    id?: string
    ok?: unknown
    error?: unknown
    result?: unknown
    host_ms?: unknown
  },
  via: 'websocket' | 'webrtc',
  pending: Map<string, Pending>,
  onSettled: () => void,
) {
  const entry = pending.get(frame.id ?? '')
  if (!entry) return
  pending.delete(frame.id ?? '')
  clearTimeout(entry.timer)
  recordRpcTiming({
    action: entry.action,
    via,
    clientMs: performance.now() - entry.startedAt,
    hostMs: typeof frame.host_ms === 'number' ? frame.host_ms : undefined,
    ok: frame.ok !== false,
  })
  onSettled()
  if (frame.ok === false) entry.reject(refusal(String(frame.error ?? '')))
  else entry.resolve(frame.result)
}
