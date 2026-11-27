import type { UsageReply } from '#/lib/usage-contract'
import {
  OPEN_ACTIONS,
  buildSignedWriteArgs,
  isTransientReconnectError,
  refusal,
  retriable,
} from './remote-auth'
import {
  NOT_PAIRED,
  adoptPairingHash,
  checkTokenRefused,
  forcedRemote,
  readPairedToken,
  relayBase,
  roomQuery,
} from './remote-pairing'
import { loadDeviceKey } from './device-key'
import { sendFocusFrame } from './remote-focus'
import { notReadyError, recordLinkEvent } from './remote-link-trace'
import type { RemoteMode, RemotePath, RemoteState } from './remote-link-trace'
import { RemoteRtc } from './remote-rtc'
import { ReplyParts } from './reply-parts'
import { median } from './rtc-path'

export { NOT_PAIRED, forcedRemote }
export type { RemoteMode, RemotePath, RemoteState }

// Remote access to the home host when the loopback Runtime is unreachable
// (phone / tablet on wezdeck.yuns.love). One WebSocket to the HostRelay
// Durable Object is always kept: it carries presence, WebRTC signaling, and
// is the fallback transport. Design: docs/remote-access.md.

const PING_MS = 2_000
const PONG_MISS_LIMIT = 3
const WAKE_PROBE_MS = 4_000
const RPC_TIMEOUT_MS = 10_000
const SLOW_WORKTREE_WRITE = /^worktree\.(recycle|remove)$/
const RECONNECT_GRACE_MS = 6_000
const OFFLINE_RTC_GRACE_MS = 2_000

type Frame = Record<string, unknown> & { t: string; id?: string }
type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

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
  private pending = new Map<string, Pending>()
  private parts = new ReplyParts()
  private pings = new Map<string, number>()
  private samples: Array<number> = []
  private seq = 0
  private started = false
  private wsRetry = 1_000
  private wsReconnectTimer?: ReturnType<typeof setTimeout>
  private wakeProbeTimer?: ReturnType<typeof setTimeout>
  private offlineRtcTimer?: ReturnType<typeof setTimeout>
  private lastFrameAt = 0
  private missedPongs = 0
  private hashListener?: () => void
  private focusBound = false
  private readonly rtc: RemoteRtc

  constructor() {
    this.rtc = new RemoteRtc({
      getSocket: () => this.ws,
      isHostOffline: () => this.state.mode === 'host-offline',
      getSamePublic: () => this.state.samePublic,
      sayHello: () => this.sayHello(),
      onFrame: (raw) => this.onFrame(raw, 'webrtc'),
      onOpened: () => {
        this.samples = []
        this.set({ mode: 'webrtc', rtcNote: undefined, rttMs: undefined })
      },
      onOpen: (path, pathDetail) => this.set({ path, pathDetail }),
      onClosed: (note, relayUp) => {
        this.samples = []
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
      },
      onNote: (rtcNote) => this.set({ rtcNote }),
      onSamePublic: (samePublic) => this.set({ samePublic }),
    })
  }

  token() {
    return readPairedToken()
  }

  /** Report active route & visibility to HostRelay DO for push noise suppression. */
  reportFocus(pathOverride?: string) {
    sendFocusFrame(this.ws, pathOverride)
  }

  /** Idempotent; called by the first consumer (getCollab / the badge). */
  start() {
    if (this.started || typeof window === 'undefined') return
    if (!this.hashListener) {
      this.hashListener = () => {
        if (!/[#&]pair=/.test(location.hash)) return
        if (adoptPairingHash()) location.reload()
      }
      window.addEventListener('hashchange', this.hashListener)
    }
    if (!this.focusBound) {
      this.focusBound = true
      document.addEventListener('visibilitychange', () => {
        this.reportFocus()
        if (document.visibilityState === 'visible')
          this.onForegroundWake('visible')
      })
      window.addEventListener('online', () => {
        this.rtc.resetBackoff()
        this.onForegroundWake('online')
      })
      window.addEventListener('popstate', () => this.reportFocus())
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
    clearTimeout(this.wsReconnectTimer)
    this.wsReconnectTimer = undefined
    const ws = new WebSocket(`${relayBase()}/relay/client${roomQuery()}`, [
      'wezdeck.v1',
      `token.${this.token()}`,
    ])
    this.ws = ws
    let opened = false
    ws.onmessage = (event) => this.onFrame(String(event.data), 'websocket')
    ws.onopen = () => {
      opened = true
      this.wsRetry = 300
      this.missedPongs = 0
      this.lastFrameAt = Date.now()
      recordLinkEvent('ws_open')
      this.reportFocus()
    }
    ws.onclose = (event) => {
      if (this.ws !== ws) return
      this.ws = undefined
      clearTimeout(this.wakeProbeTimer)
      this.wakeProbeTimer = undefined
      const dcOpen = this.rtc.isOpen()
      if (event.code === 4401) {
        this.rtc.close('pairing token rotated')
      } else if (!dcOpen) {
        this.rtc.close('relay socket closed')
        this.set({ mode: 'connecting', path: undefined, rttMs: undefined })
      }
      const refused =
        event.code === 4401
          ? Promise.resolve(true)
          : opened
            ? Promise.resolve(false)
            : checkTokenRefused(this.token())
      void refused.then((isRefused) => {
        if (isRefused) {
          recordLinkEvent('ws_close', { code: event.code, refused: true })
          this.rtc.close('pairing token rejected')
          this.set({
            mode: 'unauthorized',
            rtcNote: 'pairing token rejected; pair this device again',
          })
          return
        }
        const delay = opened ? 300 : this.wsRetry
        recordLinkEvent('ws_close', {
          code: event.code,
          reason: event.reason || undefined,
          opened,
          retryMs: delay,
        })
        clearTimeout(this.wsReconnectTimer)
        this.wsReconnectTimer = setTimeout(() => this.openSocket(), delay)
        this.wsRetry = Math.min(Math.max(this.wsRetry * 2, 600), 30_000)
      })
    }
  }

  private forceReconnect(reason: string) {
    recordLinkEvent('ws_force_reconnect', { reason, mode: this.state.mode })
    clearTimeout(this.wakeProbeTimer)
    this.wakeProbeTimer = undefined
    this.missedPongs = 0
    this.wsRetry = 300
    const prev = this.ws
    this.ws = undefined
    if (prev) {
      try {
        prev.close(4008, reason)
      } catch {
        // already closing/closed
      }
    }
    if (!this.rtc.isOpen()) {
      this.rtc.close(reason)
      this.set({ mode: 'connecting', path: undefined, rttMs: undefined })
    }
    clearTimeout(this.wsReconnectTimer)
    this.wsReconnectTimer = setTimeout(() => this.openSocket(), 100)
  }

  private onForegroundWake(source: 'visible' | 'online') {
    if (!this.started || this.state.mode === 'unauthorized') return
    this.wsRetry = 300
    this.missedPongs = 0
    const ws = this.ws
    recordLinkEvent('wake_probe', {
      source,
      mode: this.state.mode,
      wsState: ws?.readyState ?? -1,
    })
    if (
      !ws ||
      ws.readyState === WebSocket.CLOSED ||
      ws.readyState === WebSocket.CLOSING
    ) {
      clearTimeout(this.wsReconnectTimer)
      this.wsReconnectTimer = undefined
      this.openSocket()
      return
    }
    if (ws.readyState !== WebSocket.OPEN) return
    const probeAt = Date.now()
    this.sendPing()
    clearTimeout(this.wakeProbeTimer)
    this.wakeProbeTimer = setTimeout(() => {
      this.wakeProbeTimer = undefined
      if (this.lastFrameAt >= probeAt) return
      if (this.rtc.isOpen()) {
        recordLinkEvent('rtc_fallback', { reason: 'wake probe timeout' })
        this.rtc.close('WebRTC liveness timeout')
        return
      }
      if (this.ws === ws) this.forceReconnect('wake probe timeout')
    }, WAKE_PROBE_MS)
  }

  async usage() {
    return (await this.rpc('usage', {})) as UsageReply
  }

  private onFrame(raw: string, via: 'websocket' | 'webrtc') {
    let frame: Frame
    try {
      frame = JSON.parse(raw) as Frame
    } catch {
      return
    }
    this.lastFrameAt = Date.now()
    this.missedPongs = 0
    clearTimeout(this.wakeProbeTimer)
    this.wakeProbeTimer = undefined
    switch (frame.t) {
      case 'part': {
        if (!this.pending.has(String(frame.id ?? ''))) return
        const joined = this.parts.add(frame)
        if (joined !== null) this.onFrame(joined, via)
        return
      }
      case 'host': {
        this.onHostFrame(frame)
        return
      }
      case 'sig': {
        this.rtc.handleAnswer(
          frame.data as
            { type?: string; sdp?: string; samePublic?: string } | undefined,
        )
        return
      }
      case 'pong': {
        const sent = this.pings.get(frame.id ?? '')
        if (sent === undefined || frame.ok === false) return
        this.pings.delete(frame.id ?? '')
        const activeVia = this.rtc.isOpen() ? 'webrtc' : 'websocket'
        if (via !== activeVia) return
        this.samples = [...this.samples, performance.now() - sent].slice(-5)
        this.set({ rttMs: Math.round(median(this.samples)) })
        return
      }
      case 'diag.request': {
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

  private onHostFrame(frame: Frame) {
    const online = Boolean(frame.online)
    const nextSince = (frame.since as string | null) ?? null
    const sinceChanged = Boolean(
      online &&
      this.state.hostSince &&
      nextSince &&
      nextSince !== this.state.hostSince,
    )
    recordLinkEvent('host_presence', { online, since: nextSince, sinceChanged })
    const dcOpen = this.rtc.isOpen()
    if (online) {
      clearTimeout(this.offlineRtcTimer)
      this.offlineRtcTimer = undefined
      this.set({ hostSince: nextSince, mode: dcOpen ? 'webrtc' : 'websocket' })
      if (sinceChanged) {
        this.helloWs = undefined
        recordLinkEvent('reauth', { reason: 'host_since_changed' })
        void this.sayHello()
      }
      if (!dcOpen) this.rtc.schedule(0)
      return
    }
    if (dcOpen) {
      clearTimeout(this.offlineRtcTimer)
      this.offlineRtcTimer = setTimeout(() => {
        this.offlineRtcTimer = undefined
        if (!this.rtc.isOpen()) return
        this.set({ hostSince: nextSince, mode: 'host-offline' })
        this.rtc.close('host offline')
      }, OFFLINE_RTC_GRACE_MS)
      return
    }
    this.set({ hostSince: nextSince, mode: 'host-offline' })
    this.rtc.close('host offline')
  }

  private send(frame: Frame) {
    const body = JSON.stringify(frame)
    if (this.rtc.send(body)) return true
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(body)
      return true
    }
    return false
  }

  private sendPing() {
    const id = `p${++this.seq}`
    this.pings.set(id, performance.now())
    if (this.pings.size > 20) this.pings.delete(this.pings.keys().next().value!)
    return this.send({ t: 'ping', id })
  }

  private ping() {
    if (this.state.mode !== 'websocket' && this.state.mode !== 'webrtc') return
    if (
      typeof document !== 'undefined' &&
      document.visibilityState === 'hidden'
    )
      return
    if (this.missedPongs >= PONG_MISS_LIMIT) {
      const via = this.rtc.isOpen() ? 'webrtc' : 'websocket'
      recordLinkEvent('pong_timeout', {
        via,
        missed: this.missedPongs,
        silentMs: this.lastFrameAt ? Date.now() - this.lastFrameAt : -1,
      })
      if (via === 'webrtc') {
        this.missedPongs = 0
        this.rtc.close('WebRTC liveness timeout')
      } else {
        this.forceReconnect('pong timeout')
      }
      return
    }
    if (this.sendPing()) this.missedPongs++
  }

  private probeAfterTimeout(
    action: string,
    via: 'webrtc' | 'websocket',
    timeoutMs: number,
  ) {
    const silentMs = this.lastFrameAt ? Date.now() - this.lastFrameAt : -1
    recordLinkEvent('rpc_timeout', { action, via, timeoutMs, silentMs })
    if (via === 'webrtc' && silentMs > 3_000) {
      this.rtc.close('WebRTC RPC timeout')
      return
    }
    if (via === 'websocket' && silentMs > 5_000) {
      this.forceReconnect(`rpc timeout (${action})`)
      return
    }
    this.sendPing()
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

  async rpc(action: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.rpcOnce(action, args)
    } catch (error) {
      if (retriable(error, action) && this.helloWs === this.ws) {
        this.helloWs = undefined
        return this.rpcOnce(action, args)
      }
      if (isTransientReconnectError(error)) {
        const recovered = await this.ready(RECONNECT_GRACE_MS)
        if (recovered) {
          if (!OPEN_ACTIONS.has(action)) this.helloWs = undefined
          return this.rpcOnce(action, args)
        }
      }
      throw error
    }
  }

  private async rpcOnce(action: string, args: Record<string, unknown>) {
    this.start()
    const timeoutMs = SLOW_WORKTREE_WRITE.test(action) ? 90_000 : RPC_TIMEOUT_MS
    if (!this.token()) throw new Error(NOT_PAIRED)
    if (!(await this.ready(timeoutMs))) throw notReadyError(this.state.mode)
    if (!OPEN_ACTIONS.has(action)) await this.sayHello()
    return new Promise((resolve, reject) => {
      const id = `r${++this.seq}`
      const via = this.rtc.isOpen() ? 'webrtc' : 'websocket'
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.parts.drop(id)
        this.probeAfterTimeout(action, via, timeoutMs)
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

  private sayHello() {
    if (this.helloWs && this.helloWs === this.ws) return Promise.resolve()
    this.hello ??= (async () => {
      const ws = this.ws
      try {
        if (!(await loadDeviceKey())) return
        await this.write('device.hello', {})
        this.helloWs = ws
        if (
          this.ws === ws &&
          this.state.mode === 'websocket' &&
          !this.rtc.hasPeer()
        )
          this.rtc.schedule(0)
      } catch {
        // not approved (yet): the reads themselves report it
      } finally {
        this.hello = undefined
      }
    })()
    return this.hello
  }

  /** Try the DataChannel again now (e.g. after the mic grant exposed a real LAN address). */
  retryDirect() {
    this.rtc.resetBackoff()
    if (this.state.mode === 'websocket' && !this.rtc.hasPeer())
      this.rtc.schedule(0)
  }

  async write(action: string, args: Record<string, unknown>) {
    return this.rpc(action, await buildSignedWriteArgs(action, args))
  }
}

export const remoteLink = new RemoteLink()
