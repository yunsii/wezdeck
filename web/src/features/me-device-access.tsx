// 我的 › 写权限 (Device access): local approval vs paired remote device key.
import { useLingui } from '@lingui/react/macro'

import { Button } from '#/components/ui/button'
import { useDeviceState } from './device-state'
import { DeviceList } from './me-devices'

export function DeviceAccess() {
  const { t } = useLingui()
  const device = useDeviceState()
  const command = `scripts/dev/install-remote-relay.sh --approve ${device.id ?? ''}`
  if (device.state === 'checking')
    return <p className="text-caption text-brand-muted">{t`Checking…`}</p>
  if (device.state === 'approved' && device.id === 'local')
    return (
      <div className="grid gap-4">
        <p className="text-body">
          {t`Enabled on this computer: writes go through the local Runtime, with no device key to create or approve. Phones, tablets and other computers are enabled on their own.`}
        </p>
        <DeviceList />
      </div>
    )
  if (device.state === 'approved')
    return (
      <p className="text-body">
        {t`Approved. This device can read the host's sessions and tickets, send messages and reply. Each device (phone, tablet, another browser) is approved on its own, and revoking it on the host cuts reading and writing at once.`}
        <span className="mt-1 block font-mono text-meta text-brand-label">
          {device.id}
        </span>
      </p>
    )
  if (device.state === 'none')
    return (
      <div className="grid gap-2">
        <p className="text-caption text-brand-muted">
          {t`This device sees nothing from the host until it is approved — the pairing link alone is not enough. A key is created in this browser and stays here; the host approves each device once, for reading and writing.`}
        </p>
        <Button className="min-h-11" onClick={() => void device.enable()}>
          {t`Request access`}
        </Button>
        {device.error ? (
          <p role="alert" className="text-meta text-brand-error">
            {device.error}
          </p>
        ) : null}
      </div>
    )
  return (
    <div className="grid gap-2">
      <p className="text-body">
        {t`Waiting for the host to approve this device. On the host run:`}
      </p>
      <code className="block rounded-xl bg-brand-deck px-3 py-2 font-mono text-meta break-all select-all">
        {command}
      </code>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          className="min-h-11"
          onClick={() =>
            void navigator.clipboard.writeText(command).catch(() => undefined)
          }
        >
          {t`Copy command`}
        </Button>
        <Button className="min-h-11" onClick={() => void device.refresh()}>
          {t`Check again`}
        </Button>
      </div>
      {device.error ? (
        <p role="alert" className="text-meta text-brand-error">
          {device.error}
        </p>
      ) : null}
    </div>
  )
}
