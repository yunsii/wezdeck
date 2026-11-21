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
  /** selected ICE pair, e.g. "local=host remote=srflx 203.0.113.5" */
  pathDetail?: string
}

const TOKEN_KEY = 'wezdeck.remote.token'
const PING_MS = 2_000
const RPC_TIMEOUT_MS = 10_000
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

function adoptPairingHash() {
  if (typeof location === 'undefined') return
  const match = /[#&]pair=([^&]+)/.exec(location.hash)
  if (!match) return
  pairedToken = decodeURIComponent(match[1])
  try {
    storage()?.setItem(TOKEN_KEY, pairedToken)
  } catch {
    // Storage blocked (private mode / in-app browser): the token from the
    // link still applies to this page via pairedToken.
  }
  history.replaceState(null, '', location.pathname + location.search)
}

function relayBase() {
  const configured = import.meta.env.VITE_WEZDECK_RELAY_URL?.trim()
  if (configured) return configured.replace(/\/$/, '')
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`
}

function median(values: Array<number>) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

const PRIVATE_ADDRESS =
  /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fe80:|fc|fd|::1$)/i

/**
 * stats → which candidate pair carried the DataChannel. Chrome hides its own
 * host address behind mDNS, so the host side often sees a peer-reflexive
 * candidate even on one LAN; the remote (host-side) address decides instead.
 */
async function selectedPath(
  pc: RTCPeerConnection,
): Promise<{ path: RemotePath; detail: string }> {
  const stats = await pc.getStats()
  let pair:
    { localCandidateId?: string; remoteCandidateId?: string } | undefined
  stats.forEach((s: { type: string; nominated?: boolean; state?: string }) => {
    if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded')
      pair = s as typeof pair
  })
  const candidate = (id?: string) =>
    id
      ? (stats.get(id) as
          { candidateType?: string; address?: string } | undefined)
      : undefined
  const local = candidate(pair?.localCandidateId)
  const remote = candidate(pair?.remoteCandidateId)
  const detail = `local=${local?.candidateType ?? '?'} remote=${remote?.candidateType ?? '?'} ${remote?.address ?? ''}`
  if (local?.candidateType === 'relay' || remote?.candidateType === 'relay')
    return { path: 'turn', detail }
  return {
    path: PRIVATE_ADDRESS.test(remote?.address ?? '') ? 'lan' : 'internet',
    detail,
  }
}

class RemoteLink {
  state: RemoteState = {
    mode: 'unpaired',
    rpcCount: { webrtc: 0, websocket: 0 },
  }
  private listeners = new Set<() => void>()
  private ws?: WebSocket
  private pc?: RTCPeerConnection
  private dc?: RTCDataChannel
  private pending = new Map<string, Pending>()
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
        adoptPairingHash()
        location.reload()
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
    const ws = new WebSocket(`${relayBase()}/relay/client`, [
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

  private async tokenRefused() {
    try {
      const response = await fetch(
        `${relayBase().replace(/^ws/, 'http')}/relay/auth`,
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
        const data = frame.data as RTCSessionDescriptionInit | undefined
        if (data?.type === 'answer' && this.pc) {
          void this.pc.setRemoteDescription(data).catch((error: unknown) => {
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
        if (frame.ok === false)
          entry.reject(new Error(String(frame.error ?? 'remote error')))
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
      const timer = setTimeout(() => {
        off()
        resolve(false)
      }, timeoutMs)
      const off = this.subscribe(() => {
        if (!up()) return
        clearTimeout(timer)
        off()
        resolve(true)
      })
    })
  }

  async rpc(action: string, args: Record<string, unknown>): Promise<unknown> {
    this.start()
    if (!(await this.ready(RPC_TIMEOUT_MS))) {
      throw new Error(
        this.state.mode === 'host-offline'
          ? 'home host is offline'
          : this.state.mode === 'unauthorized'
            ? 'pairing token rejected; pair this device again'
            : 'remote link is not connected',
      )
    }
    return new Promise((resolve, reject) => {
      const id = `r${++this.seq}`
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('remote host did not answer in time'))
      }, RPC_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      if (!this.send({ t: 'rpc', id, action, args })) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error('remote link is not connected'))
      }
    })
  }

  private scheduleRtc(delay: number) {
    clearTimeout(this.rtcTimer)
    this.rtcTimer = setTimeout(() => void this.startRtc(), delay)
  }

  private async startRtc() {
    if (typeof RTCPeerConnection === 'undefined') {
      this.set({ rtcNote: 'WebRTC not supported by this browser' })
      return
    }
    const ws = this.ws
    if (this.pc || ws?.readyState !== WebSocket.OPEN) return
    if (new URLSearchParams(location.search).get('transport') === 'websocket') {
      this.set({ rtcNote: 'WebRTC disabled by ?transport=websocket' })
      return
    }
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
      if (pc.connectionState === 'failed') this.closeRtc('ICE failed')
    }
    this.rtcTimer = setTimeout(() => {
      if (this.pc === pc && dc.readyState !== 'open')
        this.closeRtc('no direct path within 15 s')
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
