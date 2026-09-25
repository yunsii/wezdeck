import {
  chromeStateSchema,
  healthSchema,
  imeStateSchema,
  rimeStatsSchema,
} from './runtime-contract'
import type { RuntimeSnapshot } from './runtime-contract'

const DEFAULT_RUNTIME_URL = 'http://127.0.0.1:35791'

function runtimeCandidates() {
  const configured = import.meta.env.VITE_WEZDECK_RUNTIME_URL?.trim()
  return configured ? [configured.replace(/\/$/, '')] : [DEFAULT_RUNTIME_URL]
}

function withLoopbackAddress(url: string, init: RequestInit = {}) {
  return new Request(url, {
    ...init,
    targetAddressSpace: 'loopback',
  } as RequestInit & { targetAddressSpace: 'loopback' })
}

async function requestJson<T>(
  baseUrl: string,
  path: string,
  parse: (value: unknown) => T,
) {
  const response = await fetch(withLoopbackAddress(`${baseUrl}${path}`), {
    signal: AbortSignal.timeout(900),
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`runtime returned HTTP ${response.status}`)
  return parse(await response.json())
}

export async function probeRuntime() {
  for (const baseUrl of runtimeCandidates()) {
    try {
      const health = await requestJson(
        baseUrl,
        '/api/v1/health',
        healthSchema.parse,
      )
      return { baseUrl, health }
    } catch {
      // Continue through configured endpoints and return one aggregated state.
    }
  }
  return null
}

export async function getRuntimeSnapshot(): Promise<RuntimeSnapshot> {
  const connection = await probeRuntime()
  if (!connection) throw new Error('WezDeck Runtime is not reachable')

  const { baseUrl, health } = connection
  const [rime, ime, chrome] = await Promise.all([
    requestJson(baseUrl, '/api/v1/rime/stats', rimeStatsSchema.parse).catch(
      () => null,
    ),
    requestJson(baseUrl, '/api/v1/ime', imeStateSchema.parse).catch(() => null),
    requestJson(baseUrl, '/api/v1/chrome', chromeStateSchema.parse).catch(
      () => null,
    ),
  ])
  return { health, rime, ime, chrome }
}

export function runtimeEventsUrl(baseUrl: string) {
  const url = new URL('/events', baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}
