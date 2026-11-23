import { Drawer } from '@base-ui/react/drawer'
import { useLingui } from '@lingui/react/macro'
import { X } from 'lucide-react'

import { cn } from '#/lib/utils'

/**
 * The phone's bottom sheet (Base UI Drawer: swipe down to dismiss, plus the
 * focus trap, Esc, backdrop tap and background scroll lock of a modal). The
 * swipe moves the popup through --drawer-swipe-movement-y (our transform;
 * enter / exit use the separate `translate` property, so they compose), with
 * transitions off while the finger is down. Kept on the paper colour so the
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
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Backdrop
          data-deck
          className="fixed inset-0 z-50 bg-black/50 transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0"
        />
        <Drawer.Viewport className="fixed inset-0 z-50 flex items-end justify-center md:items-center md:p-6">
          <Drawer.Popup
            data-deck
            data-testid={testId}
            data-write={write ? '' : undefined}
            className={cn(
              // the header holds still; only the body below it scrolls, so the
              // scrollbar starts under the title and never runs into a corner
              'flex max-h-[88dvh] w-full flex-col overflow-hidden rounded-t-[20px] border-t border-brand-edge bg-brand-deck text-brand-text shadow-[0_-10px_40px_rgba(0,0,0,0.28)] outline-none md:max-w-xl',
              '[transform:translateY(var(--drawer-swipe-movement-y,0px))] transition-[translate,transform,opacity,scale] duration-200 ease-out data-[swiping]:duration-0 data-[ending-style]:translate-y-full data-[starting-style]:translate-y-full',
              // a desk-sized window: a centred dialog (fade + scale), not a
              // strip stuck to the bottom with a phone's grab handle
              'md:max-h-[85dvh] md:rounded-[20px] md:border md:data-[ending-style]:translate-y-0 md:data-[ending-style]:scale-95 md:data-[ending-style]:opacity-0 md:data-[starting-style]:translate-y-0 md:data-[starting-style]:scale-95 md:data-[starting-style]:opacity-0',
              className,
            )}
          >
            <div className="shrink-0 px-4 pt-2 pb-2 md:pt-4">
              {/* the grab handle: drag the sheet down to close it */}
              <div
                aria-hidden
                className="mx-auto mb-2 h-1 w-10 rounded-full bg-brand-label/40 md:hidden"
              />
              <div className="flex items-center justify-between gap-2">
                <Drawer.Title className="text-[16px] font-semibold">
                  {title}
                </Drawer.Title>
                <Drawer.Close
                  aria-label={t`Close`}
                  className="inline-flex size-9 items-center justify-center rounded-full text-brand-muted outline-none focus-visible:ring-2 focus-visible:ring-brand-running"
                >
                  <X size={18} aria-hidden />
                </Drawer.Close>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[max(env(safe-area-inset-bottom),1rem)] md:mb-3">
              {children}
            </div>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  )
}
