import { Dialog } from '@base-ui/react/dialog'
import { useLingui } from '@lingui/react/macro'
import { X } from 'lucide-react'

import { cn } from '#/lib/utils'

/**
 * The phone's bottom sheet (Base UI Dialog: focus trap, Esc, backdrop tap
 * and background scroll lock come with it). Kept on the paper colour so the
 * cards inside read as before; what separates it from the page is a darker
 * backdrop, a top edge with a shadow and a grab handle — on the dark theme
 * the old sheet (same colour as the page, 30 % backdrop) had no visible edge.
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  testId,
  write = false,
  className,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: React.ReactNode
  testId?: string
  /** a form that writes: the host diagnostics never click inside it */
  write?: boolean
  className?: string
  children: React.ReactNode
}) {
  const { t } = useLingui()
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop
          data-deck
          className="fixed inset-0 z-50 bg-black/50 transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0"
        />
        <Dialog.Popup
          data-deck
          data-testid={testId}
          data-write={write ? '' : undefined}
          className={cn(
            'fixed inset-x-0 bottom-0 z-50 mx-auto max-h-[88dvh] w-full overflow-y-auto rounded-t-[20px] border-t border-brand-edge bg-brand-deck pb-[max(env(safe-area-inset-bottom),1rem)] text-brand-text shadow-[0_-10px_40px_rgba(0,0,0,0.28)] outline-none transition-transform duration-200 data-[ending-style]:translate-y-full data-[starting-style]:translate-y-full md:max-w-xl',
            className,
          )}
        >
          <div className="sticky top-0 z-10 bg-brand-deck px-4 pt-2 pb-2">
            <div
              aria-hidden
              className="mx-auto mb-2 h-1 w-10 rounded-full bg-brand-label/40"
            />
            <div className="flex items-center justify-between gap-2">
              <Dialog.Title className="text-[16px] font-semibold">
                {title}
              </Dialog.Title>
              <Dialog.Close
                aria-label={t`Close`}
                className="inline-flex size-9 items-center justify-center rounded-full text-brand-muted outline-none focus-visible:ring-2 focus-visible:ring-brand-running"
              >
                <X size={18} aria-hidden />
              </Dialog.Close>
            </div>
          </div>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
