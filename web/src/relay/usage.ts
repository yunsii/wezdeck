// /relay/usage — today's Cloudflare usage against the Workers Free limits,
// for the phone's 用量 card (docs/remote-access.md "Cost and free tier").
// Adapted from forge (apps/web/worker/usage.ts): Cloudflare GraphQL
// Analytics with a read-only token (Worker secrets CF_ACCOUNT_ID and
// CF_ANALYTICS_TOKEN, permission "Account Analytics: Read"); unconfigured
// → nulls and a hint. Each dataset is its own query so one failing field
// leaves the others; the reply is cached 5 minutes (Cache API).
//
// Billing in one paragraph (Cloudflare docs, checked 2026-11): Free plan,
// SQLite-backed Durable Objects only. Workers 100,000 requests / day. DO
// 100,000 requests / day and 13,000 GB-s duration / day; a WebSocket upgrade
// is 1 request, incoming WebSocket messages count 20:1, outgoing messages and
// protocol pings are free, setWebSocketAutoResponse replies cost no time.
// Duration = wall time while the object is active and cannot hibernate,
// at 128 MB. Over a limit, calls fail until 00:00 UTC — nothing is billed.

import { FREE } from '#/lib/usage-contract'
import type { UsageReply } from '#/lib/usage-contract'

export type UsageEnv = {
  RELAY_CLIENT_TOKEN: string
  CF_ACCOUNT_ID?: string
  CF_ANALYTICS_TOKEN?: string
}

const SCRIPT = 'wezdeck'
const TTL_S = 300

type GraphResult = {
  data?: unknown
  errors?: Array<{ message: string }> | null
}

async function graph(env: UsageEnv, query: string, vars: object) {
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, variables: vars }),
  })
  const body = await res.json<GraphResult>()
  if (!res.ok || body.errors?.length)
    throw new Error(body.errors?.[0]?.message ?? `HTTP ${res.status}`)
  const accounts = (body.data as { viewer?: { accounts?: Array<unknown> } })
    .viewer?.accounts
  return (accounts?.[0] ?? {}) as Record<string, Array<{ sum?: object }>>
}

const total = (rows: Array<{ sum?: object }> | undefined, key: string) =>
  (rows ?? []).reduce(
    (n, row) => n + Number((row.sum as Record<string, unknown>)[key] ?? 0),
    0,
  )

async function collect(env: UsageEnv): Promise<UsageReply> {
  const now = new Date()
  const day = now.toISOString().slice(0, 10)
  const reply: UsageReply = {
    analytics: 'unconfigured',
    errors: [],
    day,
    at: now.toISOString(),
    limits: FREE,
    worker: { requests: null, errors: null },
    durableObject: {
      requests: null,
      durationGbs: null,
      activeSeconds: null,
      wsIn: null,
      wsOut: null,
    },
  }
  if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_TOKEN) return reply
  const vars = {
    account: env.CF_ACCOUNT_ID,
    script: SCRIPT,
    day,
    start: `${day}T00:00:00Z`,
    end: now.toISOString(),
  }
  const jobs: Array<Promise<void>> = [
    graph(
      env,
      `query ($account: String!, $script: String!, $start: Time!, $end: Time!) {
        viewer { accounts(filter: { accountTag: $account }) {
          workersInvocationsAdaptive(limit: 1000, filter: { scriptName: $script, datetime_geq: $start, datetime_leq: $end }) { sum { requests errors } }
        } } }`,
      vars,
    ).then((a) => {
      reply.worker.requests = total(a.workersInvocationsAdaptive, 'requests')
      reply.worker.errors = total(a.workersInvocationsAdaptive, 'errors')
    }),
    graph(
      env,
      `query ($account: String!, $script: String!, $day: Date!) {
        viewer { accounts(filter: { accountTag: $account }) {
          durableObjectsInvocationsAdaptiveGroups(limit: 1000, filter: { scriptName: $script, date_geq: $day, date_leq: $day }) { sum { requests } }
        } } }`,
      vars,
    ).then((a) => {
      reply.durableObject.requests = total(
        a.durableObjectsInvocationsAdaptiveGroups,
        'requests',
      )
    }),
    graph(
      env,
      `query ($account: String!, $script: String!, $start: Time!, $end: Time!) {
        viewer { accounts(filter: { accountTag: $account }) {
          durableObjectsPeriodicGroups(limit: 1000, filter: { scriptName: $script, datetimeMinute_geq: $start, datetimeMinute_leq: $end }) {
            sum { activeTime inboundWebsocketMsgCount outboundWebsocketMsgCount }
          }
        } } }`,
      vars,
    ).then((a) => {
      const rows = a.durableObjectsPeriodicGroups
      // activeTime is in microseconds; duration bills 128 MB = 0.125 GB
      const seconds = total(rows, 'activeTime') / 1e6
      reply.durableObject.activeSeconds = Math.round(seconds)
      reply.durableObject.durationGbs = Math.round(seconds * 0.125 * 10) / 10
      reply.durableObject.wsIn = total(rows, 'inboundWebsocketMsgCount')
      reply.durableObject.wsOut = total(rows, 'outboundWebsocketMsgCount')
    }),
  ]
  const results = await Promise.allSettled(jobs)
  for (const result of results)
    if (result.status === 'rejected')
      reply.errors.push(String((result.reason as Error).message))
  reply.analytics =
    reply.errors.length === 0
      ? 'ok'
      : reply.errors.length === jobs.length
        ? 'error'
        : 'partial'
  return reply
}

export async function usageFetch(
  request: Request,
  env: UsageEnv,
  safeEqual: (a: string, b: string) => boolean,
) {
  const presented = (request.headers.get('authorization') ?? '').replace(
    /^Bearer /,
    '',
  )
  if (!safeEqual(presented, env.RELAY_CLIENT_TOKEN))
    return new Response('unauthorized', { status: 401 })
  const cache = (caches as unknown as { default: Cache }).default
  const key = new Request(new URL('/relay/usage/v1', request.url))
  const hit = await cache.match(key)
  if (hit) return hit
  const response = Response.json(await collect(env), {
    headers: { 'cache-control': `max-age=${TTL_S}` },
  })
  await cache.put(key, response.clone())
  return response
}
