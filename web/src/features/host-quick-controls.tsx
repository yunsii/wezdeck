import { useLingui } from '@lingui/react/macro'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { Button } from '#/components/ui/button'
import { Field, FieldList } from '#/components/ui/field'
import { SectionHeading } from '#/components/ui/section-heading'
import { hostRead, hostWrite } from '#/lib/runtime-client'
import { useDeviceState } from './device-state'
import { useConsoleMode, useRemoteState } from './console-mode'

type WarpStatus = {
  state:
    'connected' | 'disconnected' | 'connecting' | 'disconnecting' | 'unknown'
  reason?: string
}

type OppoStatus = {
  active: boolean | null
  last_result?: 'connected' | 'failed'
  last_at?: string
  error_code?: string
}

export function HostQuickControls() {
  const { t } = useLingui()
  const mode = useConsoleMode()
  const remote = useRemoteState()
  const device = useDeviceState()
  const queryClient = useQueryClient()
  const authorized = mode === 'local' || device.state === 'approved'
  const reachable =
    mode === 'local' ||
    (mode === 'remote' &&
      (remote.mode === 'websocket' || remote.mode === 'webrtc') &&
      device.state === 'approved')
  const warpKey = ['host.warp.status', mode, device.id]
  const warp = useQuery({
    queryKey: warpKey,
    queryFn: async () => (await hostRead('host.warp.status')) as WarpStatus,
    enabled: reachable,
    refetchInterval: 5000,
    retry: false,
  })
  const oppo = useQuery({
    queryKey: ['host.oppo.status', mode, device.id],
    queryFn: async () => (await hostRead('host.oppo.status')) as OppoStatus,
    enabled: reachable,
    refetchInterval: 10000,
    retry: false,
  })
  const change = useMutation({
    mutationFn: async (connected: boolean) =>
      (await hostWrite('host.warp.set', { connected })) as WarpStatus,
    onMutate: () => queryClient.cancelQueries({ queryKey: warpKey }),
    onSuccess: (status) => queryClient.setQueryData(warpKey, status),
    onSettled: () => queryClient.invalidateQueries({ queryKey: warpKey }),
  })

  const state = reachable && !warp.isError ? warp.data?.state : undefined
  const connected = state === 'connected'
  const stable = connected || state === 'disconnected'
  const unknown = t`Unknown`
  const warpLabel = {
    connected: t`Connected`,
    disconnected: t`Disconnected`,
    connecting: t`Connecting…`,
    disconnecting: t`Disconnecting…`,
    unknown,
  }[state ?? 'unknown']
  const session = reachable && !oppo.isError ? oppo.data : undefined
  const lastResult =
    session?.last_result === 'connected'
      ? t`Connected`
      : session?.last_result === 'failed'
        ? t`Connection failed`
        : t`No recent result`
  const warpError = change.error ?? warp.error
  if (!authorized) return null
  return (
    <section className="grid gap-1">
      <SectionHeading as="h2" className="bg-brand-key">
        {t`Quick controls`}
      </SectionHeading>
      <FieldList>
        <Field label="One Client (WARP)" value={warpLabel} />
        <Field
          label={t`OPPO remote control`}
          value={
            session?.active === true
              ? t`Session active`
              : session?.active === false
                ? t`No active session`
                : unknown
          }
        />
        <Field
          label={t`Latest OPPO connection`}
          value={[lastResult, session?.last_at, session?.error_code]
            .filter(Boolean)
            .join(' · ')}
        />
      </FieldList>
      <div className="flex flex-wrap items-center gap-2 px-1 pt-1">
        <Button
          size="sm"
          variant="outline"
          disabled={!stable || !reachable || change.isPending}
          onClick={() => change.mutate(!connected)}
        >
          {change.isPending
            ? t`Changing One Client…`
            : connected
              ? t`Disconnect One Client`
              : t`Connect One Client`}
        </Button>
        {reachable && !warp.isError && warp.data?.reason ? (
          <span className="text-meta text-brand-muted">{warp.data.reason}</span>
        ) : null}
      </div>
      <div role="status" className="px-1 text-meta text-brand-muted">
        {warpError?.message ??
          oppo.error?.message ??
          (mode === 'remote' && device.state !== 'approved'
            ? t`Approve this device in Device access to use host controls.`
            : null)}
      </div>
    </section>
  )
}
