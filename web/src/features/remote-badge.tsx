import { useLingui } from '@lingui/react/macro'
import { useEffect, useState, useSyncExternalStore } from 'react'

import { remoteLink } from '#/lib/remote-link'
import type { RemoteState } from '#/lib/remote-link'
import { Led } from '#/components/deck/led'
import { Button } from '#/components/ui/button'
import { cn } from '#/lib/utils'

const SERVER_STATE: RemoteState = {
  mode: 'unpaired',
  rpcCount: { webrtc: 0, websocket: 0 },
}

/**
 * Mobile browsers hide their LAN address behind mDNS (xxxx.local), and the
 * host (WSL behind the Hyper-V firewall, no inbound rules) cannot be reached
 * first. Once the site holds microphone permission the browser offers its
 * real address, so the host can dial out to it. Same trick as fe1's meeting
 * link: the stream is closed immediately, nothing is recorded.
 */
function useMicGrant() {
  const [state, setState] = useState('unknown')
  const [error, setError] = useState('')
  useEffect(() => {
    let status: PermissionStatus | undefined
    const sync = () => {
      if (status) setState(status.state)
    }
    navigator.permissions
      .query({ name: 'microphone' })
      .then((p) => {
        status = p
        sync()
        p.addEventListener('change', sync)
      })
      .catch(() => setState('unknown'))
    return () => status?.removeEventListener('change', sync)
  }, [])
  const request = async () => {
    setError('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((track) => track.stop())
      setState('granted')
      remoteLink.retryDirect()
    } catch (e) {
      setError((e as Error).name)
    }
  }
  return { state, error, request }
}

/** Connection mode + latency of the remote link; hidden when the page talks to the loopback Runtime. */
export function RemoteBadge({
  compact = false,
  className,
}: {
  compact?: boolean
  className?: string
}) {
  const { t } = useLingui()
  const state = useSyncExternalStore(
    remoteLink.subscribe,
    remoteLink.snapshot,
    () => SERVER_STATE,
  )
  const mic = useMicGrant()
  if (state.mode === 'unpaired') return null
  const offerMic =
    !compact &&
    state.mode === 'websocket' &&
    Boolean(state.rtcNote) &&
    // A mic grant only reveals a LAN address; useless across networks.
    state.samePublic !== 'no' &&
    mic.state !== 'granted' &&
    typeof navigator !== 'undefined' &&
    'mediaDevices' in navigator
  const path = {
    lan: t`LAN`,
    internet: t`internet`,
    turn: t`TURN relay`,
  }
  const pathLabel = state.path ? path[state.path] : ''
  const note = state.rtcNote ?? ''
  const short = {
    connecting: t`Connecting…`,
    'host-offline': t`Host offline`,
    unauthorized: t`Pair again`,
    websocket: t`Relay`,
    webrtc: t`Direct`,
  }
  const label = {
    connecting: t`Connecting…`,
    'host-offline': t`Host offline`,
    unauthorized: t`Token rejected — pair again`,
    websocket: t`WebSocket relay`,
    webrtc: state.path ? t`WebRTC direct · ${pathLabel}` : t`WebRTC direct`,
  }[state.mode]
  const text = compact ? short[state.mode] : label
  // direct = live (breathing ●), relay = degraded (amber ▲), down = ✕
  const ledTone =
    state.mode === 'webrtc'
      ? 'running'
      : state.mode === 'websocket'
        ? 'waiting'
        : state.mode === 'host-offline' || state.mode === 'unauthorized'
          ? 'error'
          : 'muted'
  const rtt = state.rttMs
  const micError = mic.error
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span
        data-testid={compact ? 'remote-badge-compact' : 'remote-badge'}
        data-mode={state.mode}
        data-path={state.path ?? ''}
        data-path-detail={state.pathDetail ?? ''}
        data-rtt={rtt ?? ''}
        data-rpc-webrtc={state.rpcCount.webrtc}
        data-rpc-websocket={state.rpcCount.websocket}
        title={note ? t`WebRTC: ${note}` : undefined}
        className={cn(
          'key inline-flex min-h-8 items-center gap-1.5 rounded-full text-meta whitespace-nowrap',
          compact ? 'px-2.5' : 'px-3',
          className,
        )}
      >
        <Led tone={ledTone} size={10} />
        {text}
        {rtt !== undefined && (
          <span className="text-brand-label">{rtt} ms</span>
        )}
      </span>
      {offerMic && (
        <Button
          variant="plain"
          type="button"
          data-testid="remote-mic"
          onClick={() => void mic.request()}
          title={t`Only lets the browser reveal its LAN address so the host can connect directly; the microphone is closed immediately and nothing is recorded.`}
          className="key key-press inline-flex min-h-8 items-center rounded-full px-3 text-meta"
        >
          {micError
            ? t`Grant failed (${micError}) — retry`
            : t`Allow LAN direct`}
        </Button>
      )}
    </span>
  )
}
