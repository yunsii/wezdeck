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
import { usageFetch } from './usage'
import { DurableObject } from 'cloudflare:workers'

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

/** Short digest of a token, kept on each client socket so a rotated secret can evict it. */
async function tokenTag(token: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token),
  )
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** What a refused token was, without logging it: digest + length (stale vs truncated). */
async function tokenFacts(token: string) {
  return { tag: token ? await tokenTag(token) : '', len: token.length }
}

function logEvent(event: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ category: 'relay', event, ...fields }))
}

const PRESENCE_KEY = 'host_presence'

export class HostRelay extends DurableObject<RelayEnv> {
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
      await this.setPresence(true)
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
      if (code !== 4000) await this.setPresence(false)
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
        logEvent('client_evicted', { cid: meta.cid })
      }
    }
  }

  private async presence() {
    const stored = await this.ctx.storage.get<{ since: string }>(PRESENCE_KEY)
    return {
      online: this.ctx.getWebSockets('host').length > 0,
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

function safeEqual(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** /relay/host (Bearer host token) · /relay/client (token in Sec-WebSocket-Protocol) · /relay/auth · /relay/health · /relay/usage */
export async function relayFetch(request: Request, env: RelayEnv) {
  const url = new URL(request.url)
  // ?room= picks a separate relay (one DO per room): tests run a throwaway
  // host + browser in their own room and never touch the real one.
  const room = url.searchParams.get('room') ?? 'default'
  if (!/^[a-z0-9-]{1,32}$/.test(room))
    return new Response('bad room', { status: 400 })
  // today's Cloudflare usage (Worker-side; never wakes the relay object)
  if (url.pathname === '/relay/usage')
    return usageFetch(request, env, safeEqual)
  const stub = env.HOST_RELAY.get(env.HOST_RELAY.idFromName(room))
  if (url.pathname === '/relay/health') {
    const presence = await stub.fetch('https://relay/presence')
    return new Response(presence.body, {
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
    })
  }
  if (url.pathname === '/relay/auth') {
    // Browsers cannot read a refused WebSocket handshake's status; the page
    // asks here to tell "token rejected" from "network down".
    const presented = (request.headers.get('authorization') ?? '').replace(
      /^Bearer /,
      '',
    )
    const ok = safeEqual(presented, env.RELAY_CLIENT_TOKEN)
    if (!ok)
      logEvent('auth_failed', {
        role: 'client',
        via: 'probe',
        ...(await tokenFacts(presented)),
      })
    return new Response(null, {
      status: ok ? 204 : 401,
      headers: { 'cache-control': 'no-store' },
    })
  }
  if (request.headers.get('upgrade') !== 'websocket') {
    return new Response('expected websocket', { status: 426 })
  }
  const headers = new Headers(request.headers)
  if (url.pathname === '/relay/host') {
    const auth = request.headers.get('authorization') ?? ''
    if (!safeEqual(auth, `Bearer ${env.RELAY_HOST_TOKEN}`)) {
      logEvent('auth_failed', { role: 'host' })
      return new Response('unauthorized', { status: 401 })
    }
    headers.set('x-relay-role', 'host')
  } else if (url.pathname === '/relay/client') {
    // Browsers cannot set headers on WebSocket: the token rides as a
    // subprotocol ("wezdeck.v1", "token.<secret>"); only "wezdeck.v1" is echoed.
    const protocols = (request.headers.get('sec-websocket-protocol') ?? '')
      .split(',')
      .map((p) => p.trim())
    const token = protocols.find((p) => p.startsWith('token.'))?.slice(6) ?? ''
    if (
      !protocols.includes('wezdeck.v1') ||
      !safeEqual(token, env.RELAY_CLIENT_TOKEN)
    ) {
      logEvent('auth_failed', {
        role: 'client',
        via: 'websocket',
        ...(await tokenFacts(token)),
      })
      return new Response('unauthorized', { status: 401 })
    }
    headers.set('x-relay-role', 'client')
    headers.set('x-relay-token-tag', await tokenTag(token))
    headers.set('x-relay-protocol', 'wezdeck.v1')
  } else {
    return new Response('not found', { status: 404 })
  }
  return stub.fetch(new Request(request, { headers }))
}
