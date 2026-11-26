import { useLingui } from '@lingui/react/macro'

export function useStatusText() {
  const { t } = useLingui()
  return (
    status: string,
    kind?: string,
    runningKind?: string,
    bg = 0,
    restartPending = false,
  ) =>
    restartPending
      ? t`restarting`
      : kind
        ? t`waiting for your confirmation`
        : status === 'running' && runningKind === 'background'
          ? t`${bg} background tasks running`
          : status === 'running' && runningKind === 'compacting'
            ? t`compacting the context`
            : status === 'idle'
              ? t({ message: 'Idle', context: 'session status' })
              : status === 'running'
                ? t`working`
                : status === 'waiting'
                  ? t`waiting for you`
                  : status === 'done'
                    ? t`finished its turn`
                    : status
}
