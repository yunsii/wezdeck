// HTTP + WebSocket entry routing for /relay/* (extracted from host-relay.ts
// so auth and room-gating can be unit-tested without importing cloudflare:workers).
import {
  bearerToken,
  hostAuthorized,
  logRelayEvent,
  safeEqual,
  tokenFacts,
  tokenTag,
} from './auth'
import { usageFetch } from './usage'

export interface RelayStub {
  fetch: (input: Request | string) => Promise<Response>
}

export interface RelayNamespace<TId = unknown> {
  idFromName: (name: string) => TId
  get: (id: TId) => RelayStub
}

export interface RelayFetchEnv<TId = unknown> {
  HOST_RELAY: RelayNamespace<TId>
  RELAY_HOST_TOKEN: string
  RELAY_CLIENT_TOKEN: string
  /** read-only Cloudflare analytics for /relay/usage (optional) */
  CF_ACCOUNT_ID?: string
  CF_ANALYTICS_TOKEN?: string
}

/**
 * /relay/host (Bearer host token)
 * /relay/client (token in Sec-WebSocket-Protocol)
 * /relay/auth (Bearer client token)
 * /relay/health (Bearer client or host token)
 * /relay/usage (Bearer host token)
 *
 * Authentication runs BEFORE resolving `HOST_RELAY.idFromName(room)` so
 * unauthenticated probes cannot leak host presence or wake/allocate DOs.
 */
export async function relayFetch<TId = unknown>(
  request: Request,
  env: RelayFetchEnv<TId>,
) {
  const url = new URL(request.url)
  // ?room= picks a separate relay (one DO per room): tests run a throwaway
  // host + browser in their own room and never touch the real one.
  const room = url.searchParams.get('room') ?? 'default'
  if (!/^[a-z0-9-]{1,32}$/.test(room))
    return new Response('bad room', { status: 400 })
  // today's Cloudflare usage (Worker-side; never wakes the relay object)
  if (url.pathname === '/relay/usage')
    return usageFetch(request, env, safeEqual)

  const auth = request.headers.get('authorization') ?? ''
  if (url.pathname === '/relay/auth') {
    // Browsers cannot read a refused WebSocket handshake's status; the page
    // asks here to tell "token rejected" from "network down".
    const presented = bearerToken(auth)
    const ok = safeEqual(presented, env.RELAY_CLIENT_TOKEN)
    if (!ok)
      logRelayEvent('auth_failed', {
        role: 'client',
        via: 'probe',
        ...(await tokenFacts(presented)),
      })
    return new Response(null, {
      status: ok ? 204 : 401,
      headers: { 'cache-control': 'no-store' },
    })
  }

  if (url.pathname === '/relay/health') {
    const ok =
      hostAuthorized(auth, env.RELAY_CLIENT_TOKEN) ||
      hostAuthorized(auth, env.RELAY_HOST_TOKEN)
    if (!ok) {
      logRelayEvent('auth_failed', {
        role: 'health',
        via: 'http',
        ...(await tokenFacts(bearerToken(auth))),
      })
      return new Response('unauthorized', {
        status: 401,
        headers: { 'cache-control': 'no-store' },
      })
    }
    const stub = env.HOST_RELAY.get(env.HOST_RELAY.idFromName(room))
    const presence = await stub.fetch('https://relay/presence')
    return new Response(presence.body, {
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
    })
  }

  if (url.pathname !== '/relay/host' && url.pathname !== '/relay/client') {
    return new Response('not found', { status: 404 })
  }
  if (request.headers.get('upgrade') !== 'websocket') {
    return new Response('expected websocket', { status: 426 })
  }

  const headers = new Headers(request.headers)
  if (url.pathname === '/relay/host') {
    if (!hostAuthorized(auth, env.RELAY_HOST_TOKEN)) {
      logRelayEvent('auth_failed', { role: 'host' })
      return new Response('unauthorized', { status: 401 })
    }
    headers.set('x-relay-role', 'host')
  } else {
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
      logRelayEvent('auth_failed', {
        role: 'client',
        via: 'websocket',
        ...(await tokenFacts(token)),
      })
      return new Response('unauthorized', { status: 401 })
    }
    headers.set('x-relay-role', 'client')
    headers.set('x-relay-token-tag', await tokenTag(token))
    headers.set('x-relay-protocol', 'wezdeck.v1')
  }

  const stub = env.HOST_RELAY.get(env.HOST_RELAY.idFromName(room))
  return stub.fetch(new Request(request, { headers }))
}
