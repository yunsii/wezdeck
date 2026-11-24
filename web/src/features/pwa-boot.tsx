import { useLingui } from '@lingui/react/macro'
import { useEffect } from 'react'
import { Toaster, toast } from 'sonner'

import { buildId, registerServiceWorker, useUpdateAvailable } from '#/lib/pwa'
import { UPDATED_KEY } from '#/lib/host-diag'
import { useTheme } from '#/lib/theme-provider'

/** Registers the service worker once and shows the sticky "new version" toast. */
export function PwaBoot() {
  const { t } = useLingui()
  const { mode } = useTheme()
  const update = useUpdateAvailable()
  useEffect(() => registerServiceWorker(), [])
  // a release reloaded this page onto the new build (host-diag.ts): say so
  // here, where the new version is what you see
  useEffect(() => {
    let from: string | null = null
    try {
      from = sessionStorage.getItem(UPDATED_KEY)
      sessionStorage.removeItem(UPDATED_KEY)
    } catch {
      return
    }
    if (from && from !== buildId)
      toast(t`Updated to the new version`, { id: 'updated', duration: 2500 })
  }, [t])
  useEffect(() => {
    if (!update) return
    toast(t`New version available`, {
      id: 'new-version',
      duration: Infinity,
      action: { label: t`Reload`, onClick: () => location.reload() },
    })
  }, [update, t])
  return (
    // its own transition layer that never moves with a page (styles/motion.css)
    <div className="toast-layer pointer-events-none fixed inset-0 z-[70]">
      <Toaster
        position="top-center"
        offset="calc(env(safe-area-inset-top) + 12px)"
        theme={mode === 'system' ? 'system' : mode}
      />
    </div>
  )
}
