// 我的 › 设备授权 on the host: the devices registered with the relay
// (pending / approved), read from the local Runtime (remote.devices, never
// over the relay), with 批准 / 撤销 (remote.device.approve / revoke, local
// only too). Above them, 本机来源: the browsers and scripts on the host that
// used the Runtime (GET /api/v1/clients) — they never register a key.
import { useLingui } from '@lingui/react/macro'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { SectionHeading } from '#/components/ui/section-heading'
import { hostRead, hostWrite, readLocalClients } from '#/lib/runtime-client'
import type { LocalClient } from '#/lib/runtime-client'
import { uaFallback } from './device-state'
import { ErrorLine } from './session-composer'
import { useAgo } from './tickets-view'

type DeviceView = {
  id: string
  state: 'approved' | 'pending'
  name?: string
  at?: string
  seen_at?: string
  info?: {
    browser?: string
    os?: string
    model?: string
    mobile?: boolean
    standalone?: boolean
  }
}

/** "Chrome 157 · Android 16 · model", else the old name (as --devices prints) */
function describe(device: DeviceView) {
  const info = device.info ?? {}
  const what =
    [info.browser, info.os, info.model].filter(Boolean).join(' · ') ||
    device.name ||
    '?'
  return info.standalone ? `${what} (app)` : what
}

type DeviceAction = 'device.approve' | 'device.revoke'

/** where a request came from: the production console, a dev server, a script */
function useOriginLabel() {
  const { t } = useLingui()
  return (origin: string) => {
    if (!origin) return t`No Origin (script, curl, another app)`
    if (origin === 'https://wezdeck.yuns.love') return t`Console (${origin})`
    return origin
  }
}

/**
 * 本机来源: every browser or script on the host that used the local Runtime
 * since it started (GET /api/v1/clients), so a second browser or a stray
 * dev server shows up, not only this tab. Local trust: nothing to approve.
 */
function LocalSources() {
  const { t } = useLingui()
  const ago = useAgo()
  const originLabel = useOriginLabel()
  const sources = useQuery({
    queryKey: ['runtime', 'clients'],
    staleTime: 5_000,
    refetchInterval: 15_000,
    queryFn: readLocalClients,
  })
  const list = sources.data?.clients ?? []
  const errorText = sources.error?.message ?? ''
  const here = (client: LocalClient) =>
    client.origin === location.origin &&
    client.user_agent === navigator.userAgent.slice(0, 300)
  return (
    <section className="grid gap-2" data-testid="local-sources">
      <div className="flex items-center justify-between gap-2">
        <SectionHeading>{t`Sources on this computer`}</SectionHeading>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void sources.refetch()}
          disabled={sources.isFetching}
        >
          {t`Refresh`}
        </Button>
      </div>
      <p className="text-meta text-brand-label">
        {t`Browsers and scripts that used the local Runtime since it started. They read and write without a device key, so there is nothing to approve here.`}
      </p>
      {sources.isPending ? (
        <p className="text-caption text-brand-muted">{t`Checking…`}</p>
      ) : sources.isError ? (
        <ErrorLine message={t`Could not read the sources: ${errorText}`} />
      ) : (
        <ul className="grid gap-2">
          {list.map((client) => {
            const ua = uaFallback(client.user_agent)
            const what =
              [ua.browser, ua.os].filter(Boolean).join(' · ') ||
              client.user_agent ||
              '?'
            const requests = client.requests
            const lastSeen = ago(client.last_seen)
            const writes = client.writes
            return (
              <li
                key={`${client.origin}\n${client.user_agent}`}
                data-testid="local-source"
                title={client.user_agent}
                className="grid gap-1 rounded-xl bg-brand-surface px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-body">
                    {what}
                  </span>
                  {here(client) ? (
                    <Badge size="sm" variant="ready">{t`This browser`}</Badge>
                  ) : client.live > 0 ? (
                    <Badge size="sm" variant="loading">{t`Open now`}</Badge>
                  ) : null}
                </div>
                <span className="truncate text-meta text-brand-label">
                  {originLabel(client.origin)}
                </span>
                <span className="text-meta text-brand-label">
                  {t`last ${lastSeen}`} ·{' '}
                  {t`${requests} requests, ${writes} writes`}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/** 批准 at once; 撤销 asks a second tap (it cuts the device off) */
function RowAction({
  device,
  busy,
  onAction,
}: {
  device: DeviceView
  busy: boolean
  onAction: (action: DeviceAction) => void
}) {
  const { t } = useLingui()
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    if (!confirming) return
    const timer = setTimeout(() => setConfirming(false), 4_000)
    return () => clearTimeout(timer)
  }, [confirming])
  if (device.state === 'pending')
    return (
      <Button
        size="sm"
        disabled={busy}
        onClick={() => onAction('device.approve')}
      >
        {t`Approve`}
      </Button>
    )
  return (
    <Button
      size="sm"
      variant={confirming ? 'default' : 'outline'}
      disabled={busy}
      className={confirming ? 'bg-brand-error text-white' : undefined}
      onClick={() => {
        if (!confirming) return setConfirming(true)
        setConfirming(false)
        onAction('device.revoke')
      }}
    >
      {confirming ? t`Confirm revoke` : t`Revoke`}
    </Button>
  )
}

export function DeviceList() {
  return (
    <div className="grid gap-5">
      <LocalSources />
      <RemoteDevices />
    </div>
  )
}

function RemoteDevices() {
  const { t } = useLingui()
  const ago = useAgo()
  const client = useQueryClient()
  const devices = useQuery({
    queryKey: ['remote', 'devices'],
    staleTime: 10_000,
    queryFn: async () =>
      ((await hostRead('devices')) as { devices: Array<DeviceView> }).devices,
  })
  const change = useMutation({
    mutationFn: async ({ action, id }: { action: DeviceAction; id: string }) =>
      ((await hostWrite(action, { id })) as { devices: Array<DeviceView> })
        .devices,
    onSuccess: (list) => client.setQueryData(['remote', 'devices'], list),
  })
  const list = devices.data ?? []
  const errorText = devices.error?.message ?? ''
  const changeError = change.error?.message ?? ''
  return (
    <section className="grid gap-2" data-testid="device-list">
      <div className="flex items-center justify-between gap-2">
        <SectionHeading>{t`Remote devices`}</SectionHeading>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void devices.refetch()}
          disabled={devices.isFetching}
        >
          {t`Refresh`}
        </Button>
      </div>
      <ul className="grid gap-2">
        {list.map((device) => (
          <li
            key={device.id}
            data-testid="device-row"
            data-device={device.id}
            className="grid gap-1 rounded-xl bg-brand-surface px-3 py-2"
          >
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-body">
                {describe(device)}
              </span>
              <Badge
                size="sm"
                variant={device.state === 'approved' ? 'ready' : 'warning'}
              >
                {device.state === 'approved' ? t`Approved` : t`Pending`}
              </Badge>
            </div>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 text-meta text-brand-label">
                <span className="font-mono select-all">{device.id}</span>
                {device.at ? ` · ${t`added`} ${ago(device.at)}` : ''}
                {device.seen_at ? ` · ${t`seen`} ${ago(device.seen_at)}` : ''}
              </span>
              <RowAction
                device={device}
                busy={change.isPending}
                onAction={(action) => change.mutate({ action, id: device.id })}
              />
            </div>
          </li>
        ))}
      </ul>
      {devices.isPending ? (
        <p className="text-caption text-brand-muted">{t`Checking…`}</p>
      ) : devices.isError ? (
        <ErrorLine message={t`Could not read the device list: ${errorText}`} />
      ) : list.length === 0 ? (
        <p className="text-caption text-brand-muted">
          {t`No device has asked for access yet.`}
        </p>
      ) : null}
      {change.isError ? (
        <ErrorLine message={t`Could not change the device: ${changeError}`} />
      ) : null}
      <p className="text-meta text-brand-label">
        {t`Revoking takes effect at once: the device's next read or write is refused. The host CLI does the same: scripts/dev/install-remote-relay.sh --approve / --revoke <id>.`}
      </p>
    </section>
  )
}
