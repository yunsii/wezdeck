import { useLingui } from '@lingui/react/macro'
import { useEffect } from 'react'
import { Toaster, toast } from 'sonner'

import { registerServiceWorker, useUpdateAvailable } from '#/lib/pwa'
import { useTheme } from '#/lib/theme-provider'

/** Registers the service worker once and shows the sticky "new version" toast. */
export function PwaBoot() {
  const { t } = useLingui()
  const { mode } = useTheme()
  const update = useUpdateAvailable()
  useEffect(() => registerServiceWorker(), [])
  useEffect(() => {
    if (!update) return
    toast(t`New version available`, {
      id: 'new-version',
      duration: Infinity,
      action: { label: t`Reload`, onClick: () => location.reload() },
    })
  }, [update, t])
  return (
    // its own transition layer that never moves with a page (styles.css)
    <div className="toast-layer pointer-events-none fixed inset-0 z-[70]">
      <Toaster
        position="top-center"
        offset="calc(env(safe-area-inset-top) + 12px)"
        theme={mode === 'system' ? 'system' : mode}
      />
    </div>
  )
}
