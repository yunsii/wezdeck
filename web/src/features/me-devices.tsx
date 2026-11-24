// 我的 › 设备授权 on the host: the devices registered with the relay
// (pending / approved), read from the local Runtime (remote.devices, never
// over the relay). Read only: approving and revoking stay on the host CLI,
// so each row carries the id to paste into it.
import { useLingui } from '@lingui/react/macro'
import { useQuery } from '@tanstack/react-query'

import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Field, FieldList } from '#/components/ui/field'
import { SectionHeading } from '#/components/ui/section-heading'
import { hostRead } from '#/lib/runtime-client'
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

export function DeviceList() {
  const { t } = useLingui()
  const ago = useAgo()
  const devices = useQuery({
    queryKey: ['remote', 'devices'],
    staleTime: 10_000,
    queryFn: async () =>
      ((await hostRead('devices')) as { devices: Array<DeviceView> }).devices,
  })
  const list = devices.data ?? []
  const errorText = devices.error?.message ?? ''
  return (
    <section className="grid gap-2" data-testid="device-list">
      <div className="flex items-center justify-between gap-2">
        <SectionHeading>{t`Registered devices`}</SectionHeading>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void devices.refetch()}
          disabled={devices.isFetching}
        >
          {t`Refresh`}
        </Button>
      </div>
      {devices.isPending ? (
        <p className="text-caption text-brand-muted">{t`Checking…`}</p>
      ) : devices.isError ? (
        <ErrorLine message={t`Could not read the device list: ${errorText}`} />
      ) : list.length === 0 ? (
        <p className="text-caption text-brand-muted">
          {t`No device has asked for access yet.`}
        </p>
      ) : (
        <ul className="grid gap-2">
          {list.map((device) => (
            <li
              key={device.id}
              data-testid="device-row"
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
              <span className="text-meta text-brand-label">
                <span className="font-mono select-all">{device.id}</span>
                {device.at ? ` · ${t`added`} ${ago(device.at)}` : ''}
                {device.seen_at ? ` · ${t`seen`} ${ago(device.seen_at)}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      <FieldList>
        <Field
          label={t`Approve`}
          value="scripts/dev/install-remote-relay.sh --approve <id>"
          mono
        />
        <Field
          label={t`Revoke`}
          value="scripts/dev/install-remote-relay.sh --revoke <id>"
          mono
        />
      </FieldList>
    </section>
  )
}
