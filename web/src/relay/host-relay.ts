// HostRelay: the single Durable Object between the home host
// (`wezdeck-wsl relay`, one outbound WebSocket) and remote browsers (phone /
// tablet). It only forwards frames; it never runs commands. Both sides use
// the hibernation API (ctx.acceptWebSocket), and the host keepalive "ping" is
// answered by setWebSocketAutoResponse, so an idle connection does not bill
// duration. Design and protocol: docs/remote-access.md.
//
//   client → DO   {t:"rpc"|"sig"|"ping", …}      DO adds cid → host
//   host   → DO   {t:"res"|"sig"|"pong", cid, …} DO strips cid → that client
//   DO     → client {t:"host", online, since}    presence on connect/change
//
// Zero-disruption reconnect grace: when the host disconnects transiently (e.g.
// relay restart), the DO holds off broadcasting `online:false` for
// HOST_OFFLINE_GRACE_MS (3 s) via a DO alarm and buffers up to MAX_BUFFERED_RPC
// client RPC frames in memory; as soon as the new host connects, buffered
// frames are flushed straight to it so active browser actions never fail.
import { DurableObject } from 'cloudflare:workers'
import { logRelayEvent, tokenTag } from './auth'

export { relayFetch } from './relay-fetch'

export interface RelayEnv {
  HOST_RELAY: DurableObjectNamespace<HostRelay>
  RELAY_HOST_TOKEN: string
  RELAY_CLIENT_TOKEN: string
  /** read-only Cloudflare analytics for /relay/usage (optional) */
  CF_ACCOUNT_ID?: string
  CF_ANALYTICS_TOKEN?: string
}

type Attachment =
  { role: 'host' } | { role: 'client'; cid: string; tag: string }

type BufferedRpc = {
  cid: string
  frame: Record<string, unknown>
  at: number
}

const PRESENCE_KEY = 'host_presence'
const OFFLINE_GRACE_KEY = 'host_offline_grace_until'
export const HOST_OFFLINE_GRACE_MS = 3_000
const MAX_BUFFERED_RPC = 32
const BUFFER_TTL_MS = 5_000

export class HostRelay extends DurableObject<RelayEnv> {
  private bufferedRpc: Array<BufferedRpc> = []

  constructor(ctx: DurableObjectState, env: RelayEnv) {
    super(ctx, env)
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong'),
    )
  }

  async fetch(request: Request): Promise<Response> {
    const role = request.headers.get('x-relay-role')
    if (request.headers.get('upgrade') !== 'websocket') {
      return Response.json(await this.presence())
    }
    await this.evictRotatedClients()
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    if (role === 'host') {
      for (const old of this.ctx.getWebSockets('host')) {
        old.close(4000, 'replaced by a newer host connection')
      }
      this.ctx.acceptWebSocket(server, ['host'])
      server.serializeAttachment({ role: 'host' } satisfies Attachment)
      await this.ctx.storage.deleteAlarm()
      await this.ctx.storage.delete(OFFLINE_GRACE_KEY)
      await this.setPresence(true)
      this.flushBufferedToHost(server)
    } else {
      const cid = crypto.randomUUID()
      const tag = request.headers.get('x-relay-token-tag') ?? ''
      this.ctx.acceptWebSocket(server, ['client', cid])
      server.serializeAttachment({
        role: 'client',
        cid,
        tag,
      } satisfies Attachment)
      server.send(JSON.stringify({ t: 'host', ...(await this.presence()) }))
    }
    const headers = new Headers()
    const protocol = request.headers.get('x-relay-protocol')
    if (protocol) headers.set('sec-websocket-protocol', protocol)
    return new Response(null, { status: 101, webSocket: client, headers })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string') return
    const meta = ws.deserializeAttachment() as Attachment | null
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(message) as Record<string, unknown>
    } catch {
      return
    }
    if (meta?.role === 'host') {
      if (frame.t === 'hello') return
      const cid = typeof frame.cid === 'string' ? frame.cid : ''
      const target = this.ctx.getWebSockets(cid).at(0)
      if (!target) return
      delete frame.cid
      target.send(JSON.stringify(frame))
      return
    }
    if (meta?.role !== 'client') return
    if (meta.tag !== (await this.clientTag())) {
      ws.close(4401, 'pairing token rotated')
      this.ctx
        .getWebSockets('host')
        .at(0)
        ?.send(JSON.stringify({ t: 'bye', cid: meta.cid }))
      return
    }
    if (!['rpc', 'sig', 'ping'].includes(String(frame.t))) return
    const host = this.ctx.getWebSockets('host').at(0)
    if (!host) {
      const graceUntil =
        (await this.ctx.storage.get<number>(OFFLINE_GRACE_KEY)) ?? 0
      if (
        frame.t === 'rpc' &&
        graceUntil > Date.now() &&
        this.bufferedRpc.length < MAX_BUFFERED_RPC
      ) {
        this.bufferedRpc.push({ cid: meta.cid, frame, at: Date.now() })
        return
      }
      if (frame.t === 'rpc' || frame.t === 'ping') {
        ws.send(
          JSON.stringify({
            t: frame.t === 'rpc' ? 'res' : 'pong',
            id: frame.id,
            ok: false,
            error: 'host offline',
          }),
        )
      }
      return
    }
    host.send(JSON.stringify({ ...frame, cid: meta.cid }))
  }

  async webSocketClose(ws: WebSocket, code: number) {
    const meta = ws.deserializeAttachment() as Attachment | null
    if (meta?.role === 'host') {
      // A replaced host socket closes after the new one registered.
      if (code === 4000 || this.ctx.getWebSockets('host').length > 0) return
      // Hold off offline broadcast briefly so a relay restart (~300-600 ms)
      // completes silently without flashing offline or failing clicks.
      const until = Date.now() + HOST_OFFLINE_GRACE_MS
      await this.ctx.storage.put(OFFLINE_GRACE_KEY, until)
      await this.ctx.storage.setAlarm(until)
      return
    }
    if (meta?.role === 'client') {
      this.ctx
        .getWebSockets('host')
        .at(0)
        ?.send(JSON.stringify({ t: 'bye', cid: meta.cid }))
    }
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws, 1011)
  }

  async alarm() {
    await this.ctx.storage.delete(OFFLINE_GRACE_KEY)
    const host = this.ctx.getWebSockets('host').at(0)
    if (host) {
      this.flushBufferedToHost(host)
      return
    }
    this.failBufferedAsOffline()
    await this.setPresence(false)
  }

  private flushBufferedToHost(host: WebSocket) {
    if (this.bufferedRpc.length === 0) return
    const now = Date.now()
    const queued = this.bufferedRpc
    this.bufferedRpc = []
    let flushed = 0
    for (const item of queued) {
      if (now - item.at > BUFFER_TTL_MS) continue
      if (this.ctx.getWebSockets(item.cid).length === 0) continue
      host.send(JSON.stringify({ ...item.frame, cid: item.cid }))
      flushed++
    }
    if (flushed > 0) {
      logRelayEvent('host_reconnect_flushed', { flushed })
    }
  }

  private failBufferedAsOffline() {
    if (this.bufferedRpc.length === 0) return
    const queued = this.bufferedRpc
    this.bufferedRpc = []
    for (const item of queued) {
      const target = this.ctx.getWebSockets(item.cid).at(0)
      if (!target) continue
      target.send(
        JSON.stringify({
          t: 'res',
          id: item.frame.id,
          ok: false,
          error: 'host offline',
        }),
      )
    }
  }

  private currentTag?: Promise<string>
  private clientTag() {
    this.currentTag ??= tokenTag(this.env.RELAY_CLIENT_TOKEN)
    return this.currentTag
  }

  /** Sockets opened with a token that is no longer the secret (rotation) are closed. */
  private async evictRotatedClients() {
    const current = await this.clientTag()
    for (const ws of this.ctx.getWebSockets('client')) {
      const meta = ws.deserializeAttachment() as Attachment | null
      if (meta?.role === 'client' && meta.tag !== current) {
        ws.close(4401, 'pairing token rotated')
        // the host drops this cid's WebRTC peer too: a DataChannel opened
        // with the old token would otherwise keep reading after rotation
        // (and a client that never acks the close fires no webSocketClose)
        this.ctx
          .getWebSockets('host')
          .at(0)
          ?.send(JSON.stringify({ t: 'bye', cid: meta.cid }))
        logRelayEvent('client_evicted', { cid: meta.cid })
      }
    }
  }

  private async presence() {
    const stored = await this.ctx.storage.get<{ since: string }>(PRESENCE_KEY)
    const graceUntil =
      (await this.ctx.storage.get<number>(OFFLINE_GRACE_KEY)) ?? 0
    const hostUp =
      this.ctx.getWebSockets('host').length > 0 || graceUntil > Date.now()
    return {
      online: hostUp,
      since: stored?.since ?? null,
      clients: this.ctx.getWebSockets('client').length,
    }
  }

  private async setPresence(online: boolean) {
    const since = new Date().toISOString()
    await this.ctx.storage.put(PRESENCE_KEY, { since })
    const frame = JSON.stringify({ t: 'host', online, since })
    for (const ws of this.ctx.getWebSockets('client')) ws.send(frame)
  }
}
