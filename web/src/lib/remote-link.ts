import type { UsageReply } from '#/lib/usage-contract'
import { OPEN_ACTIONS, refusal, retriable } from './remote-auth'
import { loadDeviceKey, signPayload } from './device-key'
import { ReplyParts } from './reply-parts'
import { median, selectedPath } from './rtc-path'

// Remote access to the home host when the loopback Runtime is unreachable
// (phone / tablet on wezdeck.yuns.love). One WebSocket to the HostRelay
// Durable Object is always kept: it carries presence, WebRTC signaling, and
// is the fallback transport. On top of it we try a WebRTC DataChannel straight
// to `wezdeck-wsl relay`; once open, requests use it and the relay only
// carries only signaling. Design: docs/remote-access.md.

export type RemoteMode =
  | 'unpaired'
  | 'unauthorized'
  | 'connecting'
  | 'host-offline'
  | 'websocket'
  | 'webrtc'
/** How the DataChannel got through: same LAN, NAT punched, or TURN relay. */
export type RemotePath = 'lan' | 'internet' | 'turn'

export interface RemoteState {
  mode: RemoteMode
  path?: RemotePath
  /** median round trip of the last 5 pings over the active transport */
  rttMs?: number
  hostSince?: string | null
  /** last WebRTC failure, shown so the fallback is explainable */
  rtcNote?: string
  /** answered requests per transport (observability for the badge / tests) */
  rpcCount: { webrtc: number; websocket: number }
  /** host's verdict: both sides behind the same public address (LAN path possible) */
  samePublic?: 'yes' | 'no'
  /** selected ICE pair, e.g. "local=host remote=srflx 203.0.113.5" */
  pathDetail?: string
}

const TOKEN_KEY = 'wezdeck.remote.token'
const PING_MS = 2_000
const RPC_TIMEOUT_MS = 10_000
const SLOW_WORKTREE_WRITE = /^worktree\.(recycle|remove)$/
const RTC_OPEN_TIMEOUT_MS = 15_000
const RTC_RETRY_MS = 60_000

type Frame = Record<string, unknown> & { t: string; id?: string }
type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

function storage() {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

/** `#pair=<token>` in the URL stores the client token on this device. */
/** Token from a pairing link opened in this page; wins over (possibly stale or unwritable) storage. */
let pairedToken = ''

/**
 * Adopt a `#pair=` token; true when a new one was taken. Links come from anyone:
 * replacing a token this device holds needs the person's OK, or one tapped
 * link silently swaps the pairing (unauthorized until re-paired).
 */
function adoptPairingHash(): boolean {
  if (typeof location === 'undefined') return false
  const match = /[#&]pair=([^&]+)/.exec(location.hash)
  if (!match) return false
  // tokens are [A-Za-z0-9] (install-remote-relay.sh): anything else, or a
  // %-escape that would make decodeURIComponent throw, is not a pairing link
  const token = /^[A-Za-z0-9_-]{16,128}$/.test(match[1]) ? match[1] : ''
  let current = ''
  try {
    current = storage()?.getItem(TOKEN_KEY) ?? ''
  } catch {
    current = ''
  }
  const replace =
    Boolean(token) &&
    (!current ||
      current === token ||
      window.confirm(
        document.documentElement.lang.startsWith('zh')
          ? '这个链接会替换这台设备现在的配对，确定吗？'
          : 'This link replaces the pairing on this device. Continue?',
      ))
  if (replace) {
    pairedToken = token
    try {
      storage()?.setItem(TOKEN_KEY, pairedToken)
    } catch {
      // Storage blocked (private mode / in-app browser): the token from the
      // link still applies to this page via pairedToken.
    }
  }
  // keep the router's entry state (__TSR_index / key): null here made the
  // first entry look like it came from outside the app (useCanGoBack, the
  // tab-history rule and the transition direction all read it)
  history.replaceState(
    history.state as unknown,
    '',
    location.pathname + location.search,
  )
  return replace && token !== current
}

/**
 * `?remote=1` forces the remote link even where loopback works (acceptance on
 * the host). Remembered for the tab so in-app navigation keeps it.
 */
export function forcedRemote() {
  if (typeof location === 'undefined') return false
  try {
    if (new URLSearchParams(location.search).get('remote') === '1')
      sessionStorage.setItem('wezdeck.remote.forced', '1')
    return sessionStorage.getItem('wezdeck.remote.forced') === '1'
  } catch {
    return new URLSearchParams(location.search).get('remote') === '1'
  }
}

/** `?room=` (sticky per tab) selects a separate relay room — used by tests. */
function relayRoom() {
  if (typeof location === 'undefined') return ''
  try {
    const fromUrl = new URLSearchParams(location.search).get('room')
    if (fromUrl) sessionStorage.setItem('wezdeck.remote.room', fromUrl)
    return sessionStorage.getItem('wezdeck.remote.room') ?? ''
  } catch {
    return new URLSearchParams(location.search).get('room') ?? ''
  }
}

const roomQuery = () =>
  relayRoom() ? `?room=${encodeURIComponent(relayRoom())}` : ''

function relayBase() {
  const configured = import.meta.env.VITE_WEZDECK_RELAY_URL?.trim()
  if (configured) return configured.replace(/\/$/, '')
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`
}

export const NOT_PAIRED = 'this device is not paired'

class RemoteLink {
  state: RemoteState = {
    mode: 'unpaired',
    rpcCount: { webrtc: 0, websocket: 0 },
  }
  private listeners = new Set<() => void>()
  private ws?: WebSocket
  /** the socket this device said hello on (reads need it: relay_auth.go) */
  private helloWs?: WebSocket
  private hello?: Promise<void>
  private pc?: RTCPeerConnection
  private dc?: RTCDataChannel
  private pending = new Map<string, Pending>()
  private parts = new ReplyParts()
  private pings = new Map<string, number>()
  private samples: Array<number> = []
  private seq = 0
  private started = false
  private wsRetry = 1_000
  private rtcTimer?: ReturnType<typeof setTimeout>
  private hashListener?: () => void

  token() {
    if (pairedToken) return pairedToken
    try {
      return storage()?.getItem(TOKEN_KEY) ?? ''
    } catch {
      return ''
    }
  }

  /** Idempotent; called by the first consumer (getCollab / the badge). */
  start() {
    if (this.started || typeof window === 'undefined') return
    // Opening a new pairing link in an already-open tab only changes the
    // hash (no reload): adopt it and reload so the new token is used.
    if (!this.hashListener) {
      this.hashListener = () => {
        if (!/[#&]pair=/.test(location.hash)) return
        if (adoptPairingHash()) location.reload()
      }
      window.addEventListener('hashchange', this.hashListener)
    }
    adoptPairingHash()
    if (!this.token()) return
    this.started = true
    this.set({ mode: 'connecting' })
    this.openSocket()
    setInterval(() => this.ping(), PING_MS)
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = () => this.state

  private set(patch: Partial<RemoteState>) {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  private openSocket() {
    const ws = new WebSocket(`${relayBase()}/relay/client${roomQuery()}`, [
      'wezdeck.v1',
      `token.${this.token()}`,
    ])
    this.ws = ws
    let opened = false
    ws.onmessage = (event) => this.onFrame(String(event.data), 'websocket')
    ws.onopen = () => {
      opened = true
      this.wsRetry = 1_000
    }
    ws.onclose = (event) => {
      if (this.ws !== ws) return
      this.ws = undefined
      this.closeRtc('relay socket closed')
      this.set({ mode: 'connecting', path: undefined, rttMs: undefined })
      // 4401: the DO evicted us after the token was rotated. A handshake that
      // never opened may be a refused token too; the browser hides the 401,
      // so ask /relay/auth before retrying.
      const refused =
        event.code === 4401
          ? Promise.resolve(true)
          : opened
            ? Promise.resolve(false)
            : this.tokenRefused()
      void refused.then((isRefused) => {
        if (isRefused) {
          this.set({
            mode: 'unauthorized',
            rtcNote: 'pairing token rejected; pair this device again',
          })
          return
        }
        setTimeout(() => this.openSocket(), this.wsRetry)
        this.wsRetry = Math.min(this.wsRetry * 2, 30_000)
      })
    }
  }

  /**
   * today's Cloudflare usage: asked of the host over the relay (an approved
   * device only — relay_usage.go), which fetches relay/usage.ts with the
   * host token; the client token alone no longer reads it
   */
  async usage() {
    return (await this.rpc('usage', {})) as UsageReply
  }

  private async tokenRefused() {
    try {
      const response = await fetch(
        `${relayBase().replace(/^ws/, 'http')}/relay/auth${roomQuery()}`,
        {
          headers: { authorization: `Bearer ${this.token()}` },
          cache: 'no-store',
        },
      )
      return response.status === 401
    } catch {
      return false
    }
  }

  private onFrame(raw: string, via: 'websocket' | 'webrtc') {
    let frame: Frame
    try {
      frame = JSON.parse(raw) as Frame
    } catch {
      return
    }
    switch (frame.t) {
      case 'part': {
        // a big reply in slices (lib/reply-parts.ts)
        if (!this.pending.has(String(frame.id ?? ''))) return
        const joined = this.parts.add(frame)
        if (joined !== null) this.onFrame(joined, via)
        return
      }
      case 'host': {
        const online = Boolean(frame.online)
        this.set({
          hostSince: (frame.since as string | null) ?? null,
          mode: online
            ? this.dc?.readyState === 'open'
              ? 'webrtc'
              : 'websocket'
            : 'host-offline',
        })
        if (online) this.scheduleRtc(0)
        else this.closeRtc('host offline')
        return
      }
      case 'sig': {
        const data = frame.data as
          { type?: string; sdp?: string; samePublic?: string } | undefined
        if (data?.type === 'answer' && this.pc) {
          this.set({
            samePublic:
              data.samePublic === 'yes' || data.samePublic === 'no'
                ? data.samePublic
                : undefined,
          })
          void this.pc
            .setRemoteDescription({ type: 'answer', sdp: data.sdp })
            .catch((error: unknown) => {
              this.closeRtc(`answer rejected: ${String(error)}`)
            })
        }
        return
      }
      case 'pong': {
        const sent = this.pings.get(frame.id ?? '')
        if (sent === undefined || frame.ok === false) return
        this.pings.delete(frame.id ?? '')
        const activeVia =
          this.dc?.readyState === 'open' ? 'webrtc' : 'websocket'
        if (via !== activeVia) return
        this.samples = [...this.samples, performance.now() - sent].slice(-5)
        this.set({ rttMs: Math.round(median(this.samples)) })
        return
      }
      case 'diag.request': {
        // pushed by the host (relay_diag.go); lib/host-diag.ts answers
        this.hostRequest?.(frame)
        return
      }
      case 'res': {
        const entry = this.pending.get(frame.id ?? '')
        if (!entry) return
        this.pending.delete(frame.id ?? '')
        clearTimeout(entry.timer)
        this.set({
          rpcCount: {
            ...this.state.rpcCount,
            [via]: this.state.rpcCount[via] + 1,
          },
        })
        if (frame.ok === false) entry.reject(refusal(String(frame.error ?? '')))
        else entry.resolve(frame.result)
        return
      }
    }
  }

  private send(frame: Frame) {
    const body = JSON.stringify(frame)
    if (this.dc?.readyState === 'open') {
      this.dc.send(body)
      return true
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(body)
      return true
    }
    return false
  }

  private ping() {
    if (this.state.mode !== 'websocket' && this.state.mode !== 'webrtc') return
    const id = `p${++this.seq}`
    this.pings.set(id, performance.now())
    if (this.pings.size > 20) this.pings.delete(this.pings.keys().next().value!)
    this.send({ t: 'ping', id })
  }

  /** Resolves once a transport can carry requests (first page load races the socket). */
  private ready(timeoutMs: number) {
    const up = () =>
      this.state.mode === 'websocket' || this.state.mode === 'webrtc'
    if (up()) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer)
        off()
        resolve(ok)
      }
      const timer = setTimeout(() => done(false), timeoutMs)
      const off = this.subscribe(() => {
        if (up()) done(true)
      })
    })
  }

  private hostRequest?: (frame: Frame) => void

  /** frames the host pushes unasked (diagnostics requests) */
  onHostRequest(handler: (frame: Frame) => void) {
    this.hostRequest = handler
  }

  /**
   * One request. A read refused as "not approved" on a socket that already
   * said hello means the host forgot it — the relay restarted (crash,
   * reboot, a release) while this socket stayed up: say hello again and
   * retry once. A device that really is not approved fails the hello and
   * keeps the refusal.
   */
  async rpc(action: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.rpcOnce(action, args)
    } catch (error) {
      if (!retriable(error, action) || this.helloWs !== this.ws) throw error
      this.helloWs = undefined
      return this.rpcOnce(action, args)
    }
  }

  private async rpcOnce(action: string, args: Record<string, unknown>) {
    this.start()
    const timeoutMs = SLOW_WORKTREE_WRITE.test(action) ? 90_000 : RPC_TIMEOUT_MS
    // no token: nothing will ever connect, so say why now instead of after
    // the timeout (a browser on the host itself reads tickets through the
    // local Runtime and never got paired)
    if (!this.token()) throw new Error(NOT_PAIRED)
    if (!(await this.ready(timeoutMs))) {
      throw new Error(
        this.state.mode === 'host-offline'
          ? 'home host is offline'
          : this.state.mode === 'unauthorized'
            ? 'pairing token rejected; pair this device again'
            : 'remote link is not connected',
      )
    }
    // reads need this connection to have said hello as an approved device
    if (!OPEN_ACTIONS.has(action)) await this.sayHello()
    return new Promise((resolve, reject) => {
      const id = `r${++this.seq}`
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.parts.drop(id)
        reject(new Error('remote host did not answer in time'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      if (!this.send({ t: 'rpc', id, action, args })) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error('remote link is not connected'))
      }
    })
  }

  /**
   * Once per relay socket (a reconnect is a new cid): sign `device.hello`
   * with this device's key so the host serves its reads. No key, or not
   * approved yet: reads come back "device not approved", which says what to
   * do (describeError). Concurrent requests share the one hello.
   */
  private sayHello() {
    if (this.helloWs && this.helloWs === this.ws) return Promise.resolve()
    this.hello ??= (async () => {
      const ws = this.ws
      try {
        if (!(await loadDeviceKey())) return
        await this.write('device.hello', {})
        this.helloWs = ws
        if (this.ws === ws && this.state.mode === 'websocket' && !this.pc)
          this.scheduleRtc(0)
      } catch {
        // not approved (yet): the reads themselves report it
      } finally {
        this.hello = undefined
      }
    })()
    return this.hello
  }

  private failNote(reason: string) {
    return this.state.samePublic === 'no'
      ? `${reason}: phone and host are on different networks and hole punching failed`
      : reason
  }

  /** Try the DataChannel again now (e.g. after the mic grant exposed a real LAN address). */
  retryDirect() {
    if (this.state.mode === 'websocket' && !this.pc) this.scheduleRtc(0)
  }

  /**
   * A write (send / key / reply): signed with this device's key so the host
   * can tell it came from an approved phone (device-key.ts).
   */
  async write(action: string, args: Record<string, unknown>) {
    const key = await loadDeviceKey()
    if (!key) throw new Error('writing is not enabled on this device')
    const payload = JSON.stringify({
      action,
      args,
      ts: Date.now(),
      nonce: crypto.randomUUID(),
    })
    return this.rpc(action, {
      device: key.id,
      payload,
      sig: await signPayload(key, payload),
    })
  }

  private scheduleRtc(delay: number) {
    clearTimeout(this.rtcTimer)
    this.rtcTimer = setTimeout(() => void this.startRtc(), delay)
  }

  private canStartRtc(ws: WebSocket | undefined): ws is WebSocket {
    return Boolean(
      ws && !this.pc && this.ws === ws && ws.readyState === WebSocket.OPEN,
    )
  }

  private async startRtc() {
    if (typeof RTCPeerConnection === 'undefined')
      return this.set({ rtcNote: 'WebRTC not supported by this browser' })
    const ws = this.ws
    if (!this.canStartRtc(ws)) return
    if (new URLSearchParams(location.search).get('transport') === 'websocket')
      return this.set({ rtcNote: 'WebRTC disabled by ?transport=websocket' })
    // Bind this socket to the approved device key before offering WebRTC so
    // unauthenticated connections cannot probe host ICE candidates.
    await this.sayHello()
    if (!this.canStartRtc(ws)) return
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
    })
    this.pc = pc
    const dc = pc.createDataChannel('rpc')
    dc.onmessage = (event) => this.onFrame(String(event.data), 'webrtc')
    dc.onopen = () => {
      if (this.pc !== pc) return
      this.dc = dc
      clearTimeout(this.rtcTimer)
      this.samples = []
      this.set({ mode: 'webrtc', rtcNote: undefined, rttMs: undefined })
      void selectedPath(pc).then(({ path, detail }) =>
        this.set({ path, pathDetail: detail }),
      )
    }
    dc.onclose = () => {
      if (this.pc === pc) this.closeRtc('data channel closed')
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed')
        this.closeRtc(this.failNote('ICE failed'))
    }
    this.rtcTimer = setTimeout(() => {
      if (this.pc === pc && dc.readyState !== 'open')
        this.closeRtc(this.failNote('no direct path within 15 s'))
    }, RTC_OPEN_TIMEOUT_MS)
    await pc.setLocalDescription(await pc.createOffer())
    await new Promise<void>((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve()
      const timer = setTimeout(resolve, 5_000)
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(timer)
          resolve()
        }
      })
    })
    if (this.pc !== pc) return
    // The relay socket may have closed while gathering; send() then throws.
    try {
      ws.send(
        JSON.stringify({
          t: 'sig',
          data: { type: 'offer', sdp: pc.localDescription?.sdp },
        }),
      )
    } catch {
      this.closeRtc('relay socket closed before the offer was sent')
    }
  }

  private closeRtc(note: string) {
    const hadRtc = Boolean(this.pc)
    clearTimeout(this.rtcTimer)
    this.dc?.close()
    this.pc?.close()
    this.dc = undefined
    this.pc = undefined
    if (!hadRtc) return
    this.samples = []
    const relayUp =
      this.ws?.readyState === WebSocket.OPEN &&
      this.state.mode !== 'host-offline'
    this.set({
      rtcNote: note,
      path: undefined,
      rttMs: undefined,
      mode: relayUp
        ? 'websocket'
        : this.state.mode === 'webrtc'
          ? 'connecting'
          : this.state.mode,
    })
    if (relayUp) this.scheduleRtc(RTC_RETRY_MS)
  }
}

export const remoteLink = new RemoteLink()
