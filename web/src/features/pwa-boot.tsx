import { useLingui } from '@lingui/react/macro'
import { useEffect } from 'react'
import { CircleAlert } from 'lucide-react'
import { Toaster, toast } from 'sonner'

import { buildId, registerServiceWorker, useUpdateAvailable } from '#/lib/pwa'
import { UPDATED_KEY } from '#/lib/host-diag'
import { useTheme } from '#/lib/theme-provider'

/** top only (a string sets every side): the session bar's bottom, else the
 * safe area, plus a gap */
const TOAST_TOP = 'calc(var(--toast-top, env(safe-area-inset-top, 0px)) + 12px)'

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
    <div
      data-deck
      className="toast-layer pointer-events-none fixed inset-0 z-[70]"
    >
      <Toaster
        position="top-center"
        // under the session page's top bar (--toast-top, session-header.tsx)
        // so a toast never covers its back button; the screen top elsewhere
        offset={{ top: TOAST_TOP }}
        mobileOffset={{ top: TOAST_TOP }}
        theme={mode === 'system' ? 'system' : mode}
        icons={{
          error: <CircleAlert size={16} className="text-brand-error" />,
        }}
        // the deck's own look (styles/deck.css .deck-toast): an ink card
        // like the user's message, flat, its action a pill
        toastOptions={{
          unstyled: true,
          classNames: {
            toast: 'deck-toast',
            title: 'deck-toast-title',
            description: 'deck-toast-description',
            actionButton: 'deck-toast-action',
            icon: 'deck-toast-icon',
          },
        }}
      />
    </div>
  )
}
