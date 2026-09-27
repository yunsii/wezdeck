import {
  chromeStateSchema,
  diagnosticsStateSchema,
  healthSchema,
  imeStateSchema,
  rimeStatsSchema,
  runtimeActionResponseSchema,
  sessionsStateSchema,
  wslBridgeStatusSchema,
  wakatimeStatusSchema,
  workspaceCatalogSchema,
  worktreeStatusSchema,
  vscodeStateSchema,
} from './runtime-contract'
import type {
  RuntimeActionResponse,
  DiagnosticsState,
  RuntimeSnapshot,
  SessionsState,
  WslBridgeStatus,
  WakatimeStatus,
  WorkspaceCatalog,
  WorktreeStatus,
  VscodeState,
} from './runtime-contract'

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
  init: RequestInit = {},
  timeoutMs = 900,
) {
  const response = await fetch(
    withLoopbackAddress(`${baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json', ...init.headers },
    }),
  )
  if (!response.ok) throw new Error(`runtime returned HTTP ${response.status}`)
  return parse(await response.json())
}

async function requireRuntime() {
  const connection = await probeRuntime()
  if (!connection) throw new Error('WezDeck Runtime is not reachable')
  return connection
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
  const connection = await requireRuntime()

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

export async function getWorktreeStatus(path: string): Promise<WorktreeStatus> {
  const fallback = {
    available: false,
    branch: '',
    git_changes: '',
    node_version: '',
  }
  if (!path) return fallback
  const { baseUrl, health } = await requireRuntime()
  if (!health.capabilities.includes('worktree.status')) return fallback
  return readOptional(
    baseUrl,
    '/api/v1/worktree/status?path=' + encodeURIComponent(path),
    worktreeStatusSchema.parse,
    fallback,
    8_000,
  )
}

export async function getWslBridgeStatus(): Promise<WslBridgeStatus> {
  const fallback = { available: false, socket: '' }
  const { baseUrl, health } = await requireRuntime()
  if (!health.capabilities.includes('wsl.status')) return fallback
  return readOptional(
    baseUrl,
    '/api/v1/wsl',
    wslBridgeStatusSchema.parse,
    fallback,
    3_000,
  )
}

export async function getWakatimeStatus(): Promise<WakatimeStatus> {
  const fallback = { available: false, ai: '', code: '' }
  const { baseUrl, health } = await requireRuntime()
  if (!health.capabilities.includes('wakatime.read')) return fallback
  return readOptional(
    baseUrl,
    '/api/v1/wakatime',
    wakatimeStatusSchema.parse,
    fallback,
  )
}

export async function getWorkspaces(): Promise<WorkspaceCatalog> {
  const { baseUrl, health } = await requireRuntime()
  if (!health.capabilities.includes('workspaces.read')) {
    return {
      available: false,
      workspaces: [],
      selection: { workspace: '', repo: '', worktree: '' },
    }
  }
  return readOptional(
    baseUrl,
    '/api/v1/workspaces',
    workspaceCatalogSchema.parse,
    {
      available: false,
      workspaces: [],
      selection: { workspace: '', repo: '', worktree: '' },
    },
    8_000,
  )
}

export async function getRuntimeSessions(): Promise<SessionsState> {
  const { baseUrl } = await requireRuntime()
  return readOptional(baseUrl, '/api/v1/sessions', sessionsStateSchema.parse, {
    available: false,
    entries: {},
    recent: [],
  })
}

export async function getVscodeState(): Promise<VscodeState> {
  const { baseUrl } = await requireRuntime()
  return readOptional(baseUrl, '/api/v1/vscode', vscodeStateSchema.parse, {
    available: false,
    windows: [],
  })
}

async function readOptional<T>(
  baseUrl: string,
  path: string,
  parse: (value: unknown) => T,
  fallback: T,
  timeoutMs = 900,
) {
  try {
    return await requestJson(baseUrl, path, parse, {}, timeoutMs)
  } catch {
    return fallback
  }
}

export async function getDiagnostics(
  options: {
    limit?: number
    category?: string
    level?: string
    source?: string
    trace?: string
    query?: string
  } = {},
): Promise<DiagnosticsState> {
  const { baseUrl } = await requireRuntime()
  const params = new URLSearchParams()
  if (options.limit) params.set('limit', String(options.limit))
  if (options.category) params.set('category', options.category)
  if (options.level) params.set('level', options.level)
  if (options.source) params.set('source', options.source)
  if (options.trace) params.set('trace', options.trace)
  if (options.query) params.set('q', options.query)
  const suffix = params.toString()
  return requestJson(
    baseUrl,
    `/api/v1/diagnostics${suffix ? `?${suffix}` : ''}`,
    diagnosticsStateSchema.parse,
  )
}

export async function postRuntimeAction(
  domain: string,
  action: string,
  payload: Record<string, unknown>,
): Promise<RuntimeActionResponse> {
  const { baseUrl } = await requireRuntime()
  return requestJson(
    baseUrl,
    `/api/v1/actions/${encodeURIComponent(domain)}/${encodeURIComponent(action)}`,
    runtimeActionResponseSchema.parse,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    },
  )
}

export function runtimeEventsUrl(baseUrl: string) {
  const url = new URL('/events', baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}
