import type { z } from 'zod'

import {
  collabEventsSchema,
  collabHealthSchema,
  collabListSchema,
  collabMetricsSchema,
  collabPromptSchema,
  collabRunSchema,
  collabShowSchema,
  collabTranscriptSchema,
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
import { forcedRemote, remoteLink } from './remote-link'
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

// A paired remote device would otherwise re-probe loopback (and wait for its
// timeout) before every collab request.
let lastProbe:
  { at: number; value: Awaited<ReturnType<typeof probeRuntime>> } | undefined
async function probeRuntimeCached() {
  // `?remote=1` forces the remote link even where loopback works (acceptance
  // on the host itself).
  if (forcedRemote()) return null
  if (lastProbe && Date.now() - lastProbe.at < 15_000) return lastProbe.value
  const value = await probeRuntime()
  lastProbe = { at: Date.now(), value }
  return value
}

/** this browser reads through the local Runtime (the host's own page) */
export async function readsLocally() {
  const local = await probeRuntimeCached()
  return Boolean(local?.health.capabilities.includes('remote.read'))
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

export type BrowserSlot = {
  /** which backend holds the browser slot (apply-browser-backend) */
  backend: 'ego' | 'cdp' | null
  ego_alive?: boolean
  ego_updated_at_ms?: number
}

/** the browser slot, from the status file the Runtime reads (/api/v1/browser) */
export async function getBrowserSlot(): Promise<BrowserSlot> {
  const fallback: BrowserSlot = { backend: null }
  const { baseUrl, health } = await requireRuntime()
  if (!health.capabilities.includes('browser.slot')) return fallback
  return readOptional(
    baseUrl,
    '/api/v1/browser',
    (value) => value as BrowserSlot,
    fallback,
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

// ---------------------------------------------------------------- collab
// `ticket api` through Runtime GET /api/v1/collab/<command>. A missing
// capability, HTTP error, or schema mismatch degrades to {ok:false} so the
// page renders "unavailable" instead of an error screen.
export type CollabCommand =
  | 'health'
  | 'list'
  | 'show'
  | 'events'
  | 'run'
  | 'prompt'
  | 'transcript'
  | 'metrics'

const collabParsers = {
  health: collabHealthSchema,
  list: collabListSchema,
  show: collabShowSchema,
  events: collabEventsSchema,
  run: collabRunSchema,
  prompt: collabPromptSchema,
  transcript: collabTranscriptSchema,
  metrics: collabMetricsSchema,
} as const

type CollabResult<TCommand extends CollabCommand> = z.infer<
  (typeof collabParsers)[TCommand]
>

export async function getCollab<TCommand extends CollabCommand>(
  command: TCommand,
  params: Record<string, string | number | undefined> = {},
): Promise<CollabResult<TCommand>> {
  const schema = collabParsers[command]
  const unavailable = (message: string) =>
    schema.parse({
      v: 1,
      ok: false,
      error: { code: 'unavailable', message },
    }) as CollabResult<TCommand>
  const local = await probeRuntimeCached()
  if (!local) {
    // No loopback Runtime (phone / tablet): go through the paired remote
    // link (WebRTC DataChannel, else the Cloudflare relay socket).
    remoteLink.start()
    if (!remoteLink.token()) {
      return unavailable('WezDeck Runtime is not reachable')
    }
    try {
      const args = Object.fromEntries(
        Object.entries(params).filter(([, v]) => v !== undefined && v !== ''),
      )
      return schema.parse(
        await remoteLink.rpc(command, args),
      ) as CollabResult<TCommand>
    } catch (error) {
      return unavailable(error instanceof Error ? error.message : String(error))
    }
  }
  const { baseUrl, health } = local
  if (!health.capabilities.includes('collab.read')) {
    return unavailable('Runtime does not expose collab.read yet')
  }
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value))
  }
  const suffix = query.toString()
  try {
    return (await requestJson(
      baseUrl,
      `/api/v1/collab/${command}${suffix ? `?${suffix}` : ''}`,
      (value) => schema.parse(value),
      {},
      6_000,
    )) as CollabResult<TCommand>
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error))
  }
}

/** The relay's read-only session actions (wezdeck-wsl readRPC). */
export type HostReadAction =
  | 'sessions'
  | 'session'
  | 'upload.get'
  | 'todos'
  | 'repos'
  | 'workstations'
  | 'ticket.targets'
  | 'session.new.job'
  | 'session.image'
  | 'session.history'
  | 'session.git'
  | 'session.skills'
  /** local Runtime only: the host's diagnostics requests for this page */
  | 'diag.pending'
  /** local Runtime only (serve.go): the relay does not list devices */
  | 'devices'

/**
 * Session reads, the same way collab reads go: a browser on the host asks
 * the loopback Runtime (GET /api/v1/remote/<action>, which bridges to the
 * same readRPC the relay runs), so it sees sessions without pairing; other
 * devices go over the paired remote link. Writes always take the remote
 * link: they need an approved device's signature.
 */
export async function hostRead(
  action: HostReadAction,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const local = await probeRuntimeCached()
  if (!local?.health.capabilities.includes('remote.read')) {
    return remoteLink.rpc(action, args)
  }
  const result = await requestJson(
    local.baseUrl,
    `/api/v1/remote/${action}?args=${encodeURIComponent(JSON.stringify(args))}`,
    (value) => value,
    {},
    9_000,
  )
  if (
    result &&
    typeof result === 'object' &&
    (result as { available?: unknown }).available === false
  ) {
    const error = (result as { error?: unknown }).error
    throw new Error(String(error ?? 'the host bridge is unavailable'))
  }
  return result
}

/** the local Runtime takes writes without a device key (remote_write.go) */
export async function hasLocalWrite() {
  const local = await probeRuntimeCached()
  return Boolean(local?.health.capabilities.includes('remote.write'))
}

/**
 * Writes into sessions and tickets. On this computer, through the local
 * Runtime (POST /api/v1/remote/<action>): loopback, origin-checked, no device
 * key to pair and approve. Elsewhere, over the remote link, signed by this
 * device's approved key. The host runs the same action and guards either way.
 */
export async function hostWrite(
  action: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const local = await probeRuntimeCached()
  if (!local?.health.capabilities.includes('remote.write')) {
    return remoteLink.write(action, args)
  }
  const result = await requestJson(
    local.baseUrl,
    `/api/v1/remote/${action}`,
    (value) => value,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    },
    // past the Runtime's own write timeout (75 s; the ticket CLI takes up
    // to 60 s): giving up first said "failed" while the write went on, and
    // a retry made a second ticket
    80_000,
  )
  if (
    result &&
    typeof result === 'object' &&
    (result as { available?: unknown }).available === false
  ) {
    const error = (result as { error?: unknown }).error
    throw new Error(String(error ?? 'the host bridge is unavailable'))
  }
  return result
}

export type LocalClient = {
  origin: string
  user_agent: string
  first_seen: string
  last_seen: string
  requests: number
  writes: number
  /** open /events sockets: a tab that is open right now */
  live: number
}

/**
 * Every source on the host that used the local Runtime (Origin + browser),
 * kept in the Runtime's memory since it started (RuntimeWebServer.Clients.cs).
 * Local only: there is no relay equivalent.
 */
export async function readLocalClients() {
  const local = await probeRuntimeCached()
  if (!local?.health.capabilities.includes('clients.read'))
    throw new Error('the local Runtime does not list clients yet (sync it)')
  return requestJson(
    local.baseUrl,
    '/api/v1/clients',
    (value) => value as { since_ms: number; clients: Array<LocalClient> },
    {},
    5_000,
  )
}
