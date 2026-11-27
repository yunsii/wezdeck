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
import { dispatchPushEmit, handlePushHttp } from './host-push'
import type { PushEnv } from './host-push'

export { relayFetch } from './relay-fetch'

export interface RelayEnv extends PushEnv {
  HOST_RELAY: DurableObjectNamespace<HostRelay>
  RELAY_HOST_TOKEN: string
  RELAY_CLIENT_TOKEN: string
  /** read-only Cloudflare analytics for /relay/usage (optional) */
  CF_ACCOUNT_ID?: string
  CF_ANALYTICS_TOKEN?: string
}

type HostAttachment = {
  role: 'host'
  hid?: string
  connectedAt?: number
  replaced?: boolean
}

type ClientAttachment = {
  role: 'client'
  cid: string
  tag: string
  connectedAt?: number
  deviceId?: string
  visible?: boolean
  path?: string
}

type Attachment = HostAttachment | ClientAttachment

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
const WS_OPEN = 1

function isOpenSocket(ws: WebSocket): boolean {
  // Cloudflare Workers WebSocket uses readyState === 1 (OPEN).
  return ws.readyState === WS_OPEN
}

function readAttachment(ws: WebSocket): Attachment | null {
  try {
    return ws.deserializeAttachment() as Attachment | null
  } catch {
    return null
  }
}

export class HostRelay extends DurableObject<RelayEnv> {
  private bufferedRpc: Array<BufferedRpc> = []

  constructor(ctx: DurableObjectState, env: RelayEnv) {
    super(ctx, env)
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong'),
    )
  }

  /**
   * Open, non-replaced host sockets ordered newest-first.
   * Picking `.at(0)` without filtering allowed a half-open / CLOSING old host
   * socket (e.g. after a TCP reset + fast reconnect) to sit at index 0 and
   * swallow every client frame while the newer socket stayed idle on ping/pong.
   */
  private openHosts(): Array<WebSocket> {
    const all = this.ctx.getWebSockets('host')
    const live: Array<{ ws: WebSocket; at: number; idx: number }> = []
    for (let i = 0; i < all.length; i++) {
      const ws = all[i]
      if (!isOpenSocket(ws)) continue
      const meta = readAttachment(ws)
      if (meta?.role === 'host' && meta.replaced) continue
      const at = meta?.role === 'host' ? (meta.connectedAt ?? 0) : 0
      live.push({ ws, at, idx: i })
    }
    live.sort((a, b) => b.at - a.at || b.idx - a.idx)
    return live.map((item) => item.ws)
  }

  private openClients(): Array<WebSocket> {
    return this.ctx.getWebSockets('client').filter(isOpenSocket)
  }

  private sendToHost(frame: Record<string, unknown>, context: string): boolean {
    const payload = JSON.stringify(frame)
    for (const host of this.openHosts()) {
      try {
        host.send(payload)
        return true
      } catch (err) {
        const meta = readAttachment(host)
        const hid = meta?.role === 'host' ? (meta.hid ?? 'unknown') : 'unknown'
        if (meta?.role === 'host') {
          try {
            host.serializeAttachment({ ...meta, replaced: true })
          } catch {
            // ignore attachment failure on dead socket
          }
        }
        try {
          host.close(1011, 'host send failed')
        } catch {
          // already closing/closed
        }
        logRelayEvent('host_send_error', {
          hid,
          context,
          t: String(frame.t ?? ''),
          cid: typeof frame.cid === 'string' ? frame.cid : '',
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return false
  }

  private sendToClient(
    ws: WebSocket,
    frame: Record<string, unknown>,
    cid: string,
    context: string,
  ): boolean {
    if (!isOpenSocket(ws)) return false
    try {
      ws.send(JSON.stringify(frame))
      return true
    } catch (err) {
      logRelayEvent('client_send_error', {
        cid,
        context,
        t: String(frame.t ?? ''),
        err: err instanceof Error ? err.message : String(err),
      })
      return false
    }
  }

  private sendToDevice(
    deviceId: string,
    frame: Record<string, unknown>,
  ): boolean {
    let delivered = false
    for (const clientWs of this.openClients()) {
      const cm = readAttachment(clientWs)
      if (cm?.role === 'client' && cm.deviceId === deviceId) {
        if (this.sendToClient(clientWs, frame, cm.cid, 'push_ws')) {
          delivered = true
        }
      }
    }
    return delivered
  }

  async fetch(request: Request): Promise<Response> {
    const role = request.headers.get('x-relay-role')
    if (request.headers.get('upgrade') !== 'websocket') {
      const url = new URL(request.url)
      if (url.pathname.startsWith('/push/')) {
        return handlePushHttp(request, this.ctx.storage, this.env, (id, f) =>
          this.sendToDevice(id, f),
        )
      }
      return Response.json(await this.presence())
    }
    await this.evictRotatedClients()
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    if (role === 'host') {
      const existing = this.ctx.getWebSockets('host')
      let replacedCount = 0
      for (const old of existing) {
        const oldMeta = readAttachment(old)
        if (oldMeta?.role === 'host' && !oldMeta.replaced) {
          replacedCount++
          try {
            old.serializeAttachment({ ...oldMeta, replaced: true })
          } catch {
            // ignore on already-closed socket
          }
        }
        try {
          old.close(4000, 'replaced by a newer host connection')
        } catch {
          // already closing/closed
        }
      }
      const hid = crypto.randomUUID().slice(0, 8)
      this.ctx.acceptWebSocket(server, ['host'])
      server.serializeAttachment({
        role: 'host',
        hid,
        connectedAt: Date.now(),
      } satisfies HostAttachment)
      await this.ctx.storage.deleteAlarm()
      await this.ctx.storage.delete(OFFLINE_GRACE_KEY)
      await this.setPresence(true)
      this.flushBufferedToHost(server)
      logRelayEvent('host_connected', {
        hid,
        replaced_count: replacedCount,
        hosts: this.openHosts().length,
        hosts_total: this.ctx.getWebSockets('host').length,
        clients: this.openClients().length,
      })
    } else {
      const cid = crypto.randomUUID()
      const tag = request.headers.get('x-relay-token-tag') ?? ''
      this.ctx.acceptWebSocket(server, ['client', cid])
      server.serializeAttachment({
        role: 'client',
        cid,
        tag,
        connectedAt: Date.now(),
      } satisfies ClientAttachment)
      const p = await this.presence()
      this.sendToClient(server, { t: 'host', ...p }, cid, 'initial_presence')
      logRelayEvent('client_connected', {
        cid,
        host_online: p.online,
        hosts: p.hosts,
        hosts_total: p.hosts_total,
        clients: p.clients,
      })
    }
    const headers = new Headers()
    const protocol = request.headers.get('x-relay-protocol')
    if (protocol) headers.set('sec-websocket-protocol', protocol)
    return new Response(null, { status: 101, webSocket: client, headers })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string') return
    const meta = readAttachment(ws)
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(message) as Record<string, unknown>
    } catch {
      return
    }
    if (meta?.role === 'host') {
      if (frame.t === 'hello') return
      if (frame.t === 'push.emit') {
        const focusedByDevice = new Map<string, Set<string>>()
        for (const clientWs of this.openClients()) {
          const cm = readAttachment(clientWs)
          if (cm?.role === 'client' && cm.visible && cm.deviceId) {
            const set = focusedByDevice.get(cm.deviceId) ?? new Set<string>()
            set.add(cm.path || '/')
            focusedByDevice.set(cm.deviceId, set)
          }
        }
        await dispatchPushEmit(
          frame,
          this.ctx.storage,
          this.env,
          focusedByDevice,
          (id, f) => this.sendToDevice(id, f),
        )
        return
      }
      const cid = typeof frame.cid === 'string' ? frame.cid : ''
      const target = this.ctx.getWebSockets(cid).find(isOpenSocket)
      if (!target) return
      delete frame.cid
      this.sendToClient(target, frame, cid, 'host_frame')
      return
    }
    if (meta?.role !== 'client') return
    if (meta.tag !== (await this.clientTag())) {
      try {
        ws.close(4401, 'pairing token rotated')
      } catch {
        // already closing/closed
      }
      this.sendToHost({ t: 'bye', cid: meta.cid }, 'client_rotated')
      return
    }
    if (frame.t === 'focus') {
      try {
        ws.serializeAttachment({
          ...meta,
          deviceId:
            typeof frame.device_id === 'string'
              ? frame.device_id.slice(0, 128)
              : meta.deviceId,
          visible: frame.visible === true,
          path: typeof frame.path === 'string' ? frame.path.slice(0, 200) : '',
        } satisfies ClientAttachment)
      } catch {
        // ignore attachment update failure
      }
      return
    }
    if (!['rpc', 'sig', 'ping'].includes(String(frame.t))) return
    if (this.sendToHost({ ...frame, cid: meta.cid }, 'client_frame')) {
      return
    }
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
      this.sendToClient(
        ws,
        {
          t: frame.t === 'rpc' ? 'res' : 'pong',
          id: frame.id,
          ok: false,
          error: 'host offline',
        },
        meta.cid,
        'host_offline_reply',
      )
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    const meta = readAttachment(ws)
    if (meta?.role === 'host') {
      // Mark closed host as replaced so openHosts() never picks it if still
      // present in getWebSockets('host') during shutdown.
      if (!meta.replaced) {
        try {
          ws.serializeAttachment({ ...meta, replaced: true })
        } catch {
          // ignore on closed socket
        }
      }
      const remaining = this.openHosts().length
      logRelayEvent('host_closed', {
        hid: meta.hid ?? 'unknown',
        code,
        replaced: Boolean(meta.replaced),
        remaining_hosts: remaining,
        hosts_total: this.ctx.getWebSockets('host').length,
      })
      // A replaced host socket closes after the new one registered.
      if (code === 4000 || meta.replaced || remaining > 0) return
      // Hold off offline broadcast briefly so a relay restart (~300-600 ms)
      // completes silently without flashing offline or failing clicks.
      const until = Date.now() + HOST_OFFLINE_GRACE_MS
      await this.ctx.storage.put(OFFLINE_GRACE_KEY, until)
      await this.ctx.storage.setAlarm(until)
      return
    }
    if (meta?.role === 'client') {
      this.sendToHost({ t: 'bye', cid: meta.cid }, 'client_closed')
      logRelayEvent('client_closed', {
        cid: meta.cid,
        code,
        clients: this.openClients().length,
      })
    }
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws, 1011)
  }

  async alarm() {
    await this.ctx.storage.delete(OFFLINE_GRACE_KEY)
    const host = this.openHosts().at(0)
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
      if (!this.ctx.getWebSockets(item.cid).some(isOpenSocket)) continue
      try {
        host.send(JSON.stringify({ ...item.frame, cid: item.cid }))
        flushed++
      } catch (err) {
        logRelayEvent('host_send_error', {
          context: 'flush_buffered',
          t: String(item.frame.t ?? ''),
          cid: item.cid,
          err: err instanceof Error ? err.message : String(err),
        })
      }
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
      const target = this.ctx.getWebSockets(item.cid).find(isOpenSocket)
      if (!target) continue
      this.sendToClient(
        target,
        {
          t: 'res',
          id: item.frame.id,
          ok: false,
          error: 'host offline',
        },
        item.cid,
        'buffered_offline',
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
      const meta = readAttachment(ws)
      if (meta?.role === 'client' && meta.tag !== current) {
        try {
          ws.close(4401, 'pairing token rotated')
        } catch {
          // already closing/closed
        }
        // the host drops this cid's WebRTC peer too: a DataChannel opened
        // with the old token would otherwise keep reading after rotation
        // (and a client that never acks the close fires no webSocketClose)
        this.sendToHost({ t: 'bye', cid: meta.cid }, 'client_evicted')
        logRelayEvent('client_evicted', { cid: meta.cid })
      }
    }
  }

  private async presence() {
    const stored = await this.ctx.storage.get<{ since: string }>(PRESENCE_KEY)
    const graceUntil =
      (await this.ctx.storage.get<number>(OFFLINE_GRACE_KEY)) ?? 0
    const openHosts = this.openHosts()
    const active = openHosts.at(0)
    const activeMeta = active ? readAttachment(active) : null
    const openClients = this.openClients()
    const hostUp = openHosts.length > 0 || graceUntil > Date.now()
    return {
      online: hostUp,
      since: stored?.since ?? null,
      clients: openClients.length,
      clients_total: this.ctx.getWebSockets('client').length,
      hosts: openHosts.length,
      hosts_total: this.ctx.getWebSockets('host').length,
      host_id: activeMeta?.role === 'host' ? (activeMeta.hid ?? null) : null,
    }
  }

  private async setPresence(online: boolean) {
    const since = new Date().toISOString()
    await this.ctx.storage.put(PRESENCE_KEY, { since })
    const frame = { t: 'host', online, since }
    const clients = this.openClients()
    for (const ws of clients) {
      const meta = readAttachment(ws)
      const cid = meta?.role === 'client' ? meta.cid : ''
      this.sendToClient(ws, frame, cid, 'presence_broadcast')
    }
    logRelayEvent('presence_changed', {
      online,
      hosts: this.openHosts().length,
      hosts_total: this.ctx.getWebSockets('host').length,
      clients: clients.length,
    })
  }
}
