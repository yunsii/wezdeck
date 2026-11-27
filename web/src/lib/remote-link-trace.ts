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
const linkEvents: Array<LinkTraceEvent> = []

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
