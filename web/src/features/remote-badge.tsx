import { useLingui } from '@lingui/react/macro'
import { useSyncExternalStore } from 'react'

import { remoteLink } from '#/lib/remote-link'
import type { RemoteState } from '#/lib/remote-link'
import { cn } from '#/lib/utils'

const SERVER_STATE: RemoteState = {
  mode: 'unpaired',
  rpcCount: { webrtc: 0, websocket: 0 },
}

/** Connection mode + latency of the remote link; hidden when the page talks to the loopback Runtime. */
export function RemoteBadge() {
  const { t } = useLingui()
  const state = useSyncExternalStore(
    remoteLink.subscribe,
    remoteLink.snapshot,
    () => SERVER_STATE,
  )
  if (state.mode === 'unpaired') return null
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
  return (
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
  )
}
