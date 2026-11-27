import { nextRtcRetryDelay, recordLinkEvent } from './remote-link-trace'
import { selectedPath } from './rtc-path'
import type { RemotePath } from './remote-link'

const RTC_DISCONNECT_FALLBACK_MS = 3_000
const RTC_OPEN_TIMEOUT_MS = 15_000
const RTC_RETRY_MS = 60_000

export interface RemoteRtcHost {
  getSocket: () => WebSocket | undefined
  isHostOffline: () => boolean
  getSamePublic: () => 'yes' | 'no' | undefined
  sayHello: () => Promise<void>
  onFrame: (raw: string) => void
  onOpen: (path: RemotePath | undefined, detail: string | undefined) => void
  onOpened: () => void
  onClosed: (note: string, relayUp: boolean) => void
  onNote: (note: string) => void
  onSamePublic: (samePublic: 'yes' | 'no' | undefined) => void
}

/**
 * Manages the optional WebRTC DataChannel alongside the relay WebSocket:
 * non-trickle offer/answer, 3 s fast fallback on ICE `disconnected`, and
 * progressive retry backoff when `samePublic === 'no'`.
 */
export class RemoteRtc {
  private pc?: RTCPeerConnection
  private dc?: RTCDataChannel
  private rtcTimer?: ReturnType<typeof setTimeout>
  private disconnectTimer?: ReturnType<typeof setTimeout>
  private consecutiveFails = 0

  constructor(private readonly host: RemoteRtcHost) {}

  isOpen() {
    return this.dc?.readyState === 'open'
  }

  hasPeer() {
    return Boolean(this.pc)
  }

  send(body: string) {
    if (this.dc?.readyState !== 'open') return false
    this.dc.send(body)
    return true
  }

  resetBackoff() {
    this.consecutiveFails = 0
  }

  schedule(delay: number) {
    clearTimeout(this.rtcTimer)
    this.rtcTimer = setTimeout(() => void this.start(), delay)
  }

  handleAnswer(data?: { type?: string; sdp?: string; samePublic?: string }) {
    if (data?.type !== 'answer' || !this.pc) return
    this.host.onSamePublic(
      data.samePublic === 'yes' || data.samePublic === 'no'
        ? data.samePublic
        : undefined,
    )
    void this.pc
      .setRemoteDescription({ type: 'answer', sdp: data.sdp })
      .catch((error: unknown) => {
        this.close(`answer rejected: ${String(error)}`)
      })
  }

  private failNote(reason: string) {
    return this.host.getSamePublic() === 'no'
      ? `${reason}: phone and host are on different networks and hole punching failed`
      : reason
  }

  private canStart(ws: WebSocket | undefined): ws is WebSocket {
    return Boolean(
      ws &&
      !this.pc &&
      this.host.getSocket() === ws &&
      ws.readyState === WebSocket.OPEN,
    )
  }

  async start() {
    if (typeof RTCPeerConnection === 'undefined')
      return this.host.onNote('WebRTC not supported by this browser')
    const ws = this.host.getSocket()
    if (!this.canStart(ws)) return
    if (new URLSearchParams(location.search).get('transport') === 'websocket')
      return this.host.onNote('WebRTC disabled by ?transport=websocket')
    await this.host.sayHello()
    if (!this.canStart(ws)) return

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
    })
    this.pc = pc
    const dc = pc.createDataChannel('rpc')
    dc.onmessage = (event) => this.host.onFrame(String(event.data))
    dc.onopen = () => {
      if (this.pc !== pc) return
      this.dc = dc
      this.consecutiveFails = 0
      clearTimeout(this.rtcTimer)
      clearTimeout(this.disconnectTimer)
      this.disconnectTimer = undefined
      recordLinkEvent('rtc_open')
      this.host.onOpened()
      void selectedPath(pc).then(({ path, detail }) =>
        this.host.onOpen(path, detail),
      )
    }
    dc.onclose = () => {
      if (this.pc === pc) this.close('data channel closed')
    }
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return
      if (pc.connectionState === 'connected') {
        clearTimeout(this.disconnectTimer)
        this.disconnectTimer = undefined
        return
      }
      if (pc.connectionState === 'disconnected') {
        clearTimeout(this.disconnectTimer)
        this.disconnectTimer = setTimeout(() => {
          this.disconnectTimer = undefined
          if (this.pc === pc && pc.connectionState === 'disconnected') {
            recordLinkEvent('rtc_fallback', { reason: 'ICE disconnected' })
            this.close(this.failNote('ICE disconnected'))
          }
        }, RTC_DISCONNECT_FALLBACK_MS)
        return
      }
      if (pc.connectionState === 'failed') {
        clearTimeout(this.disconnectTimer)
        this.disconnectTimer = undefined
        this.close(this.failNote('ICE failed'))
      }
    }
    this.rtcTimer = setTimeout(() => {
      if (this.pc === pc && dc.readyState !== 'open')
        this.close(this.failNote('no direct path within 15 s'))
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
    try {
      ws.send(
        JSON.stringify({
          t: 'sig',
          data: { type: 'offer', sdp: pc.localDescription?.sdp },
        }),
      )
    } catch {
      this.close('relay socket closed before the offer was sent')
    }
  }

  close(note: string) {
    const hadRtc = Boolean(this.pc)
    const wasOpen = this.dc?.readyState === 'open'
    clearTimeout(this.rtcTimer)
    clearTimeout(this.disconnectTimer)
    this.disconnectTimer = undefined
    this.dc?.close()
    this.pc?.close()
    this.dc = undefined
    this.pc = undefined
    if (!hadRtc) return
    if (!wasOpen) this.consecutiveFails++
    const ws = this.host.getSocket()
    const relayUp =
      ws?.readyState === WebSocket.OPEN && !this.host.isHostOffline()
    this.host.onClosed(note, relayUp)
    if (relayUp) {
      const delay = nextRtcRetryDelay(
        this.host.getSamePublic(),
        this.consecutiveFails,
        RTC_RETRY_MS,
      )
      recordLinkEvent('rtc_closed', {
        note,
        wasOpen,
        fails: this.consecutiveFails,
        retryMs: delay,
      })
      this.schedule(delay)
    }
  }
}
