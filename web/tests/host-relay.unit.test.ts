import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostRelay } from '#/relay/host-relay'
import type { RelayEnv } from '#/relay/host-relay'
import { tokenTag } from '#/relay/auth'

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject<TEnv = unknown> {
    ctx: unknown
    env: TEnv
    constructor(ctx: unknown, env: TEnv) {
      this.ctx = ctx
      this.env = env
    }
  },
}))

class FakeWebSocket {
  readyState = 1
  attachment: unknown = null
  sent: Array<string> = []
  closed: Array<{ code?: number; reason?: string }> = []
  failSend = false

  send(data: string) {
    if (this.failSend) throw new Error('broken pipe')
    if (this.readyState !== 1) throw new Error('socket not open')
    this.sent.push(data)
  }

  close(code?: number, reason?: string) {
    this.closed.push({ code, reason })
    this.readyState = 2 // CLOSING (simulates peer not yet ACKing close)
  }

  serializeAttachment(value: unknown) {
    this.attachment = value
  }

  deserializeAttachment() {
    return this.attachment
  }
}

class FakeContext {
  sockets: Array<{ ws: FakeWebSocket; tags: Array<string> }> = []
  storageMap = new Map<string, unknown>()
  alarmAt: number | null = null
  autoResponse: unknown = null

  storage = {
    get: async <T>(key: string) => this.storageMap.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      this.storageMap.set(key, value)
    },
    delete: async (key: string) => {
      this.storageMap.delete(key)
    },
    setAlarm: async (at: number) => {
      this.alarmAt = at
    },
    deleteAlarm: async () => {
      this.alarmAt = null
    },
  }

  setWebSocketAutoResponse(pair: unknown) {
    this.autoResponse = pair
  }

  acceptWebSocket(ws: FakeWebSocket, tags: Array<string>) {
    this.sockets.push({ ws, tags })
  }

  getWebSockets(tag?: string) {
    if (!tag) return this.sockets.map((entry) => entry.ws)
    return this.sockets
      .filter((entry) => entry.tags.includes(tag))
      .map((entry) => entry.ws)
  }
}

function makeRelay() {
  const createdPairs: Array<[FakeWebSocket, FakeWebSocket]> = []
  vi.stubGlobal(
    'WebSocketPair',
    class {
      0: FakeWebSocket
      1: FakeWebSocket
      constructor() {
        const pair: [FakeWebSocket, FakeWebSocket] = [
          new FakeWebSocket(),
          new FakeWebSocket(),
        ]
        this[0] = pair[0]
        this[1] = pair[1]
        createdPairs.push(pair)
      }
    },
  )
  vi.stubGlobal(
    'WebSocketRequestResponsePair',
    class {
      constructor(
        public req: string,
        public res: string,
      ) {}
    },
  )
  // Node's Response forbids status 101; stub minimally for fetch() return check.
  const RealResponse = globalThis.Response
  vi.stubGlobal(
    'Response',
    class extends RealResponse {
      static override json = RealResponse.json.bind(RealResponse)
      constructor(
        body?: BodyInit | null,
        init?: ResponseInit & { webSocket?: unknown },
      ) {
        if (init?.status === 101) {
          super(null, { status: 200, headers: init.headers })
          Object.defineProperty(this, 'status', { value: 101 })
        } else {
          super(body, init)
        }
      }
    },
  )

  const ctx = new FakeContext()
  const env = {
    HOST_RELAY: {} as RelayEnv['HOST_RELAY'],
    RELAY_HOST_TOKEN: 'host-secret',
    RELAY_CLIENT_TOKEN: 'client-secret',
  } satisfies RelayEnv
  const relay = new HostRelay(ctx as unknown as DurableObjectState, env)
  return { relay, ctx, createdPairs }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('HostRelay host selection & observability', () => {
  it('routes client frames to the newest open host when an old replaced host stays CLOSING at index 0', async () => {
    const { relay, ctx, createdPairs } = makeRelay()
    const tag = await tokenTag('client-secret')

    // Host 1 connects, then Host 2 reconnects before Host 1 finishes closing.
    await relay.fetch(
      new Request('https://relay/host', {
        headers: { upgrade: 'websocket', 'x-relay-role': 'host' },
      }),
    )
    const host1 = createdPairs[0][1]
    await relay.fetch(
      new Request('https://relay/host', {
        headers: { upgrade: 'websocket', 'x-relay-role': 'host' },
      }),
    )
    const host2 = createdPairs[1][1]

    // Host 1 stays in getWebSockets('host') at index 0 (CLOSING + replaced).
    expect(ctx.getWebSockets('host')).toEqual([host1, host2])
    expect(host1.readyState).toBe(2)

    // Client connects and sends an RPC frame.
    await relay.fetch(
      new Request('https://relay/client', {
        headers: {
          upgrade: 'websocket',
          'x-relay-role': 'client',
          'x-relay-token-tag': tag,
        },
      }),
    )
    const client = createdPairs[2][1]
    await relay.webSocketMessage(
      client as unknown as WebSocket,
      JSON.stringify({ t: 'rpc', id: 'r1', action: 'sessions', args: {} }),
    )

    // Must land on host2, never host1.
    expect(host1.sent).toEqual([])
    expect(host2.sent).toHaveLength(1)
    expect(JSON.parse(host2.sent[0])).toMatchObject({
      t: 'rpc',
      id: 'r1',
      action: 'sessions',
    })

    // /presence exposes open hosts vs total hosts so stuck sockets are visible.
    const presenceRes = await relay.fetch(new Request('https://relay/presence'))
    const presence = await presenceRes.json<Record<string, unknown>>()
    expect(presence).toMatchObject({
      online: true,
      hosts: 1,
      hosts_total: 2,
      clients: 1,
      clients_total: 1,
    })
    expect(typeof presence.host_id).toBe('string')
  })

  it('catches host.send errors, logs host_send_error, closes the broken socket, and replies host offline', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { relay, createdPairs } = makeRelay()
    const tag = await tokenTag('client-secret')

    await relay.fetch(
      new Request('https://relay/host', {
        headers: { upgrade: 'websocket', 'x-relay-role': 'host' },
      }),
    )
    const host = createdPairs[0][1]
    host.failSend = true

    await relay.fetch(
      new Request('https://relay/client', {
        headers: {
          upgrade: 'websocket',
          'x-relay-role': 'client',
          'x-relay-token-tag': tag,
        },
      }),
    )
    const client = createdPairs[1][1]
    client.sent = []

    await relay.webSocketMessage(
      client as unknown as WebSocket,
      JSON.stringify({ t: 'rpc', id: 'r2', action: 'health', args: {} }),
    )

    expect(host.closed).toEqual([{ code: 1011, reason: 'host send failed' }])
    expect(client.sent).toHaveLength(1)
    expect(JSON.parse(client.sent[0])).toMatchObject({
      t: 'res',
      id: 'r2',
      ok: false,
      error: 'host offline',
    })
    const events = logSpy.mock.calls.map(([line]) => JSON.parse(String(line)))
    expect(events.some((e) => e.event === 'host_send_error')).toBe(true)
  })

  it('schedules offline grace when the only live host closes even if an old replaced host remains in getWebSockets', async () => {
    const { relay, ctx, createdPairs } = makeRelay()
    await relay.fetch(
      new Request('https://relay/host', {
        headers: { upgrade: 'websocket', 'x-relay-role': 'host' },
      }),
    )
    await relay.fetch(
      new Request('https://relay/host', {
        headers: { upgrade: 'websocket', 'x-relay-role': 'host' },
      }),
    )
    const host2 = createdPairs[1][1]
    host2.readyState = 3
    await relay.webSocketClose(host2 as unknown as WebSocket, 1006)
    expect(ctx.alarmAt).not.toBeNull()

    // Alarm runs after grace expires: presence drops to offline even though
    // host1 is still sitting in ctx.sockets in CLOSING state.
    await relay.alarm()
    const presence = await (
      await relay.fetch(new Request('https://relay/presence'))
    ).json<Record<string, unknown>>()
    expect(presence).toMatchObject({
      online: false,
      hosts: 0,
      hosts_total: 2,
      host_id: null,
    })
  })

  it('closes a broken client socket and notifies the host bye on client_send_error', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { relay, createdPairs } = makeRelay()
    await relay.fetch(
      new Request('https://relay/host', {
        headers: { upgrade: 'websocket', 'x-relay-role': 'host' },
      }),
    )
    const host = createdPairs[0][1]
    const tag = await tokenTag('client-secret')
    await relay.fetch(
      new Request('https://relay/client', {
        headers: {
          upgrade: 'websocket',
          'x-relay-role': 'client',
          'x-relay-token-tag': tag,
        },
      }),
    )
    const client = createdPairs[1][1]
    const cid = (client.attachment as { cid: string }).cid
    client.failSend = true
    host.sent = []

    await relay.webSocketMessage(
      host as unknown as WebSocket,
      JSON.stringify({ t: 'res', cid, id: 'r9', ok: true, result: {} }),
    )

    expect(client.closed).toEqual([
      { code: 1011, reason: 'client send failed' },
    ])
    expect(host.sent.map((s) => JSON.parse(s))).toContainEqual({
      t: 'bye',
      cid,
    })
    const events = logSpy.mock.calls.map(([line]) => JSON.parse(String(line)))
    expect(events.some((e) => e.event === 'client_send_error')).toBe(true)
  })
})
