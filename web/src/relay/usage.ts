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
  RELAY_HOST_TOKEN: string
  CF_ACCOUNT_ID?: string
  CF_ANALYTICS_TOKEN?: string
}

const WEB_SCRIPT = 'wezdeck'
const DO_SCRIPT = 'wezdeck-relay-do'
const WORKER_SCRIPTS = [WEB_SCRIPT, DO_SCRIPT]
const DO_SCRIPTS = [DO_SCRIPT, WEB_SCRIPT]
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
  const body: GraphResult = await res.json()
  if (!res.ok || body.errors?.length)
    throw new Error(body.errors?.[0]?.message ?? `HTTP ${res.status}`)
  const accounts = (body.data as { viewer?: { accounts?: Array<unknown> } })
    .viewer?.accounts
  return (accounts?.[0] ?? {}) as Record<
    string,
    Array<{ sum?: object }> | undefined
  >
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
      otherRequests: null,
      durationGbs: null,
      activeSeconds: null,
      wsIn: null,
      wsOut: null,
    },
  }
  if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_TOKEN) return reply
  const vars = {
    account: env.CF_ACCOUNT_ID,
    workerScripts: WORKER_SCRIPTS,
    doScripts: DO_SCRIPTS,
    day,
    start: `${day}T00:00:00Z`,
    end: now.toISOString(),
  }
  const jobs: Array<Promise<void>> = [
    graph(
      env,
      `query ($account: String!, $workerScripts: [String!], $start: Time!, $end: Time!) {
        viewer { accounts(filter: { accountTag: $account }) {
          workersInvocationsAdaptive(limit: 1000, filter: { scriptName_in: $workerScripts, datetime_geq: $start, datetime_leq: $end }) { sum { requests errors } }
        } } }`,
      vars,
    ).then((a) => {
      reply.worker.requests = total(a.workersInvocationsAdaptive, 'requests')
      reply.worker.errors = total(a.workersInvocationsAdaptive, 'errors')
    }),
    // Durable Object: invocations by type ("hibernation" = one incoming
    // WebSocket message delivered to the hibernating relay, "http" =
    // upgrades and presence fetches). Analytics count every message; billing
    // counts incoming messages 20:1. The periodic dataset (active time,
    // outgoing messages) cannot filter by script, so it is summed over the
    // namespaces the invocations reported.
    graph(
      env,
      `query ($account: String!, $doScripts: [String!], $day: Date!) {
        viewer { accounts(filter: { accountTag: $account }) {
          durableObjectsInvocationsAdaptiveGroups(limit: 1000, filter: { scriptName_in: $doScripts, date_geq: $day, date_leq: $day }) {
            sum { requests } dimensions { type namespaceId }
          }
        } } }`,
      vars,
    ).then(async (a) => {
      const rows = (a.durableObjectsInvocationsAdaptiveGroups ?? []) as Array<{
        sum?: { requests?: number }
        dimensions?: { type?: string; namespaceId?: string }
      }>
      let messages = 0
      let other = 0
      const namespaces = new Set<string>()
      for (const row of rows) {
        const n = Number(row.sum?.requests ?? 0)
        if (row.dimensions?.type === 'hibernation') messages += n
        else other += n
        if (row.dimensions?.namespaceId)
          namespaces.add(row.dimensions.namespaceId)
      }
      const unit = reply.durableObject
      unit.wsIn = messages
      unit.otherRequests = other
      unit.requests = other + Math.ceil(messages / 20)
      if (!namespaces.size) {
        unit.activeSeconds = 0
        unit.durationGbs = 0
        unit.wsOut = 0
        return
      }
      const periodic = await graph(
        env,
        `query ($account: String!, $start: Time!, $end: Time!, $ns: [String!]) {
          viewer { accounts(filter: { accountTag: $account }) {
            durableObjectsPeriodicGroups(limit: 1000, filter: { namespaceId_in: $ns, datetimeMinute_geq: $start, datetimeMinute_leq: $end }) {
              sum { activeTime outboundWebsocketMsgCount }
            }
          } } }`,
        { ...vars, ns: [...namespaces] },
      )
      // activeTime is in microseconds; duration bills 128 MB = 0.125 GB
      const seconds =
        total(periodic.durableObjectsPeriodicGroups, 'activeTime') / 1e6
      unit.activeSeconds = Math.round(seconds)
      unit.durationGbs = Math.round(seconds * 0.125 * 10) / 10
      unit.wsOut = total(
        periodic.durableObjectsPeriodicGroups,
        'outboundWebsocketMsgCount',
      )
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
  const header = request.headers.get('authorization') ?? ''
  const prefix = 'Bearer '
  const presented = header.startsWith(prefix) ? header.slice(prefix.length) : ''
  // the host token only: the page asks the host (`usage` over the relay,
  // where only an approved device gets an answer — relay_usage.go), and the
  // host asks here. The shared client token used to be enough, so a revoked
  // or never-approved browser still saw the account's usage.
  if (!env.RELAY_HOST_TOKEN || !safeEqual(presented, env.RELAY_HOST_TOKEN))
    return new Response('unauthorized', { status: 401 })
  const cache = (caches as unknown as { default: Cache }).default
  const key = new Request(new URL('/relay/usage/v2', request.url))
  const hit = await cache.match(key)
  if (hit) return hit
  const response = Response.json(await collect(env), {
    headers: { 'cache-control': `max-age=${TTL_S}` },
  })
  await cache.put(key, response.clone())
  return response
}
