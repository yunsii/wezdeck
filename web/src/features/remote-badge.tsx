import { useLingui } from '@lingui/react/macro'
import { useEffect, useState, useSyncExternalStore } from 'react'

import { remoteLink } from '#/lib/remote-link'
import type { RemoteState } from '#/lib/remote-link'
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
export function RemoteBadge() {
  const { t } = useLingui()
  const state = useSyncExternalStore(
    remoteLink.subscribe,
    remoteLink.snapshot,
    () => SERVER_STATE,
  )
  const mic = useMicGrant()
  if (state.mode === 'unpaired') return null
  const offerMic =
    state.mode === 'websocket' &&
    Boolean(state.rtcNote) &&
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
  const label = {
    connecting: t`Connecting…`,
    'host-offline': t`Host offline`,
    unauthorized: t`Token rejected — pair again`,
    websocket: t`WebSocket relay`,
    webrtc: state.path ? t`WebRTC direct · ${pathLabel}` : t`WebRTC direct`,
  }[state.mode]
  const tone =
    state.mode === 'webrtc'
      ? 'bg-emerald-500'
      : state.mode === 'websocket'
        ? 'bg-amber-500'
        : state.mode === 'host-offline' || state.mode === 'unauthorized'
          ? 'bg-red-500'
          : 'bg-zinc-400'
  const rtt = state.rttMs
  const micError = mic.error
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span
        data-testid="remote-badge"
        data-mode={state.mode}
        data-path={state.path ?? ''}
        data-path-detail={state.pathDetail ?? ''}
        data-rtt={rtt ?? ''}
        data-rpc-webrtc={state.rpcCount.webrtc}
        data-rpc-websocket={state.rpcCount.websocket}
        title={note ? t`WebRTC: ${note}` : undefined}
        className="inline-flex items-center gap-1.5 border border-brand-border px-2 py-0.5 font-mono text-xs"
      >
        <span className={cn('size-2 rounded-full', tone)} aria-hidden />
        {label}
        {rtt !== undefined && (
          <span className="text-brand-label">· {rtt} ms</span>
        )}
      </span>
      {offerMic && (
        <button
          type="button"
          data-testid="remote-mic"
          onClick={() => void mic.request()}
          title={t`Only lets the browser reveal its LAN address so the host can connect directly; the microphone is closed immediately and nothing is recorded.`}
          className="border border-brand-border px-2 py-0.5 text-xs underline-offset-2 hover:underline"
        >
          {micError
            ? t`Grant failed (${micError}) — retry`
            : t`Allow LAN direct`}
        </button>
      )}
    </span>
  )
}
