import { useLingui } from '@lingui/react/macro'
import { useEffect } from 'react'
import { toast } from 'sonner'
import { onOptimisticTimeout } from '#/lib/optimistic-state'

export function usePromptTimeoutNotice(id: string) {
  const { t } = useLingui()
  useEffect(
    () =>
      onOptimisticTimeout((event) => {
        if (
          event.scope === 'session' &&
          event.id === id &&
          (event.kind === 'prompt-submit' || event.kind === 'prompt-cancel')
        ) {
          toast.warning(
            t`The host did not confirm the action; please check and retry.`,
          )
        }
      }),
    [id, t],
  )
}
