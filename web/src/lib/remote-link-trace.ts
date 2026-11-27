// Dedicated ring buffer for remote-link transport diagnostics (ws close codes,
// pong timeouts, wake probes, RPC timeouts, RTC fallback & backoff, reauth).
// Kept separate from client-trace.ts's general 300-event buffer so high-volume
// UI/session-sync events never evict connection failure forensics.

export type RemoteMode =
  | 'unpaired'
  | 'unauthorized'
  | 'connecting'
  | 'host-offline'
  | 'websocket'
  | 'webrtc'
/** How the DataChannel got through: same LAN, NAT punched, or TURN relay. */
export type RemotePath = 'lan' | 'internet' | 'turn'

export interface RemoteState {
  mode: RemoteMode
  path?: RemotePath
  /** median round trip of the last 5 pings over the active transport */
  rttMs?: number
  hostSince?: string | null
  /** last WebRTC failure, shown so the fallback is explainable */
  rtcNote?: string
  /** answered requests per transport (observability for the badge / tests) */
  rpcCount: { webrtc: number; websocket: number }
  /** host's verdict: both sides behind the same public address (LAN path possible) */
  samePublic?: 'yes' | 'no'
  /** selected ICE pair, e.g. "local=host remote=srflx 203.0.113.5" */
  pathDetail?: string
}

export function notReadyError(mode: RemoteMode) {
  return new Error(
    mode === 'host-offline'
      ? 'home host is offline'
      : mode === 'unauthorized'
        ? 'pairing token rejected; pair this device again'
        : 'remote link is not connected',
  )
}

export type LinkTraceEvent = {
  at: string
  t: number
  event: string
  data?: Record<string, unknown>
}

const MAX_LINK_EVENTS = 80
const MAX_RPC_SAMPLES = 50
export const SLOW_RPC_MS = 1_500
const linkEvents: Array<LinkTraceEvent> = []

type RpcLatencySample = {
  action: string
  via: 'websocket' | 'webrtc'
  clientMs: number
  hostMs?: number
  rttMs?: number
  ok: boolean
}

const rpcSamples: Array<RpcLatencySample> = []
let rpcSlowCount = 0

export function recordLinkEvent(event: string, data?: Record<string, unknown>) {
  const t =
    typeof performance !== 'undefined' ? Math.round(performance.now()) : 0
  linkEvents.push({
    at: new Date().toISOString(),
    t,
    event,
    ...(data ? { data } : {}),
  })
  if (linkEvents.length > MAX_LINK_EVENTS) linkEvents.shift()
}

export function recordRpcTiming(sample: {
  action: string
  via: 'websocket' | 'webrtc'
  clientMs: number
  hostMs?: number
  ok: boolean
}) {
  const clientMs = Math.max(0, Math.round(sample.clientMs))
  const hostMs =
    typeof sample.hostMs === 'number' && Number.isFinite(sample.hostMs)
      ? Math.max(0, Math.round(sample.hostMs))
      : undefined
  const rttMs =
    hostMs !== undefined ? Math.max(0, clientMs - hostMs) : undefined
  rpcSamples.push({
    action: sample.action,
    via: sample.via,
    clientMs,
    hostMs,
    rttMs,
    ok: sample.ok,
  })
  if (rpcSamples.length > MAX_RPC_SAMPLES) rpcSamples.shift()
  if (clientMs >= SLOW_RPC_MS) {
    rpcSlowCount++
    recordLinkEvent('rpc_slow', {
      action: sample.action,
      via: sample.via,
      ok: sample.ok,
      clientMs,
      ...(hostMs !== undefined ? { hostMs, rttMs } : {}),
    })
  }
}

function percentile(values: Array<number>, p: number) {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))
  return sorted[idx]
}

export function rpcLatencySnapshot() {
  if (rpcSamples.length === 0) {
    return { count: 0, slowCount: rpcSlowCount }
  }
  const client = rpcSamples.map((s) => s.clientMs)
  const host = rpcSamples
    .map((s) => s.hostMs)
    .filter((v): v is number => v !== undefined)
  const rtt = rpcSamples
    .map((s) => s.rttMs)
    .filter((v): v is number => v !== undefined)
  return {
    count: rpcSamples.length,
    slowCount: rpcSlowCount,
    clientP50Ms: percentile(client, 0.5),
    clientP95Ms: percentile(client, 0.95),
    clientMaxMs: Math.max(...client),
    ...(host.length > 0
      ? {
          hostP50Ms: percentile(host, 0.5),
          hostP95Ms: percentile(host, 0.95),
          rttP50Ms: percentile(rtt, 0.5),
          rttP95Ms: percentile(rtt, 0.95),
        }
      : {}),
  }
}

export function linkEventsSnapshot() {
  const now =
    typeof performance !== 'undefined' ? Math.round(performance.now()) : 0
  return linkEvents.map((item) => ({
    at: item.at,
    t: item.t - now,
    event: item.event,
    ...(item.data ? { data: item.data } : {}),
  }))
}

export function resetLinkEvents() {
  linkEvents.length = 0
  rpcSamples.length = 0
  rpcSlowCount = 0
}

/**
 * Compute next WebRTC retry delay: when phone and host are on different
 * networks (`samePublic === 'no'`) and hole punching repeatedly fails, back off
 * 60 s -> 180 s -> 600 s instead of hammering STUN/pion every minute forever.
 */
export function nextRtcRetryDelay(
  samePublic: 'yes' | 'no' | undefined,
  consecutiveFails: number,
  baseMs = 60_000,
) {
  if (samePublic !== 'no' || consecutiveFails <= 1) return baseMs
  if (consecutiveFails === 2) return 180_000
  return 600_000
}

export function parseRelayFrame(
  raw: string,
): (Record<string, unknown> & { t: string; id?: string }) | null {
  try {
    return JSON.parse(raw) as Record<string, unknown> & {
      t: string
      id?: string
    }
  } catch {
    return null
  }
}

export function evalHostPresence(
  frame: Record<string, unknown>,
  prevSince: string | null | undefined,
) {
  const online = Boolean(frame.online)
  const nextSince = (frame.since as string | null) ?? null
  const sinceChanged = Boolean(
    online && prevSince && nextSince && nextSince !== prevSince,
  )
  recordLinkEvent('host_presence', { online, since: nextSince, sinceChanged })
  return { online, nextSince, sinceChanged }
}

export function closeSocketSafely(
  ws: WebSocket | undefined,
  code: number,
  reason: string,
) {
  if (!ws) return
  try {
    ws.close(code, reason)
  } catch {
    // already closing/closed
  }
}

export function nextWsBackoff(current: number) {
  return Math.min(Math.max(current * 2, 600), 30_000)
}

export function classifyRpcTimeout(
  action: string,
  via: 'webrtc' | 'websocket',
  timeoutMs: number,
  lastFrameAt: number,
): 'close-rtc' | 'reconnect-ws' | 'ping' {
  const silentMs = lastFrameAt ? Date.now() - lastFrameAt : -1
  recordLinkEvent('rpc_timeout', { action, via, timeoutMs, silentMs })
  if (via === 'webrtc' && silentMs > 3_000) return 'close-rtc'
  if (via === 'websocket' && silentMs > 5_000) return 'reconnect-ws'
  return 'ping'
}
