import { Drawer } from '@base-ui/react/drawer'
import { useLingui } from '@lingui/react/macro'
import { ArrowLeft, X } from 'lucide-react'

import { Button } from './button'
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
  subtitle,
  actions,
  onBack,
  fullscreen = false,
  testId,
  write = false,
  className,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: React.ReactNode
  subtitle?: React.ReactNode
  actions?: React.ReactNode
  /** return from a nested view without dismissing the sheet */
  onBack?: () => void
  /** edge-to-edge full-viewport sheet for long-form documents and code */
  fullscreen?: boolean
  testId?: string
  /** a form that writes: the host diagnostics never click inside it */
  write?: boolean
  className?: string
  children: React.ReactNode
}) {
  const { t } = useLingui()
  return (
    <Drawer.Root
      open={open}
      onOpenChange={onOpenChange}
      disablePointerDismissal={fullscreen}
    >
      <Drawer.Portal>
        {!fullscreen ? (
          <Drawer.Backdrop
            data-deck
            className="fixed inset-0 z-50 bg-black/50 transition-opacity duration-[var(--motion-medium)] ease-[var(--ease-standard)] data-[ending-style]:opacity-0 data-[ending-style]:duration-[var(--motion-short)] data-[starting-style]:opacity-0 starting:opacity-0"
          />
        ) : null}
        <Drawer.Viewport
          className={cn(
            'fixed inset-0 z-50 flex justify-center',
            fullscreen
              ? 'items-stretch p-0'
              : 'items-end md:items-center md:p-6',
          )}
        >
          <Drawer.Popup
            data-deck
            data-testid={testId}
            data-write={write ? '' : undefined}
            data-fullscreen={fullscreen ? 'true' : undefined}
            className={cn(
              // the header holds still; only the body below it scrolls, so the
              // scrollbar starts under the title and never runs into a corner
              'flex w-full flex-col overflow-hidden bg-brand-deck text-brand-text outline-none',
              // Fullscreen reader opens directly at opacity 1 and follows the
              // fixed inset-0 viewport (`h-full`, not `100dvh`) with no hidden
              // backdrop or opacity transition that churns GPU layers.
              fullscreen
                ? 'h-full max-h-full max-w-none rounded-none border-0'
                : cn(
                    'max-h-[88dvh] rounded-t-[20px] border-t border-brand-edge shadow-[0_-10px_40px_rgba(0,0,0,0.28)] md:max-w-xl',
                    // motion tokens (styles/motion.css): in slower and decelerating, out
                    // faster and accelerating; a finger on it moves it 1:1
                    '[transform:translateY(var(--drawer-swipe-movement-y,0px))] transition-[translate,transform,opacity,scale] duration-[var(--motion-medium)] ease-[var(--ease-enter)] data-[ending-style]:duration-[var(--motion-short)] data-[ending-style]:ease-[var(--ease-exit)] data-[swiping]:duration-0 data-[ending-style]:translate-y-full data-[starting-style]:translate-y-full starting:translate-y-full',
                    // @starting-style too: the popup mounts and loses data-starting-style
                    // before its first style resolution, so that alone never animated
                    // reduced motion: it fades, it does not travel
                    'motion-reduce:data-[ending-style]:translate-y-0 motion-reduce:data-[ending-style]:opacity-0 motion-reduce:data-[starting-style]:translate-y-0 motion-reduce:data-[starting-style]:opacity-0 motion-reduce:starting:translate-y-0 motion-reduce:starting:opacity-0',
                    // a desk-sized window: a centred dialog (fade + scale), not a
                    // strip stuck to the bottom with a phone's grab handle
                    'md:max-h-[85dvh] md:rounded-2xl md:border md:data-[ending-style]:translate-y-0 md:data-[ending-style]:scale-[0.96] md:data-[ending-style]:opacity-0 md:data-[starting-style]:translate-y-0 md:data-[starting-style]:scale-[0.96] md:data-[starting-style]:opacity-0 md:starting:translate-y-0 md:starting:scale-[0.96] md:starting:opacity-0',
                  ),
              className,
            )}
          >
            <div
              className={cn(
                'shrink-0',
                fullscreen
                  ? 'flex min-h-16 flex-col justify-center border-b border-brand-edge bg-brand-surface px-3 pt-[max(env(safe-area-inset-top),0.5rem)] pb-2 md:px-5'
                  : 'px-4 pt-2 pb-2 md:pt-4',
              )}
            >
              {!fullscreen ? (
                /* the grab handle: drag the sheet down to close it */
                <div
                  aria-hidden
                  className="mx-auto mb-2 h-1 w-10 rounded-full bg-brand-label/40 md:hidden"
                />
              ) : null}
              <div
                className={cn(
                  'flex items-center gap-2',
                  onBack && !fullscreen ? 'justify-start' : 'justify-between',
                )}
              >
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  {onBack ? (
                    <Button
                      variant="plain"
                      type="button"
                      aria-label={t`Back`}
                      onClick={onBack}
                      className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-brand-muted outline-none hover:bg-brand-soft hover:text-brand-text focus-visible:ring-2 focus-visible:ring-brand-running"
                    >
                      <ArrowLeft size={19} aria-hidden />
                    </Button>
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <Drawer.Title
                      className={cn(
                        'truncate font-semibold',
                        fullscreen ? 'text-body md:text-title' : 'text-title',
                      )}
                    >
                      {title}
                    </Drawer.Title>
                    {subtitle ? (
                      <div className="mt-0.5 min-w-0">{subtitle}</div>
                    ) : null}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {actions}
                  {fullscreen || !onBack ? (
                    <Drawer.Close
                      aria-label={t`Close`}
                      className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-brand-muted outline-none hover:bg-brand-soft hover:text-brand-text focus-visible:ring-2 focus-visible:ring-brand-running"
                    >
                      <X size={18} aria-hidden />
                    </Drawer.Close>
                  ) : null}
                </div>
              </div>
            </div>
            <div
              className={cn(
                'min-h-0 flex-1 overflow-y-auto overscroll-contain',
                fullscreen
                  ? 'pb-[max(env(safe-area-inset-bottom),1.5rem)]'
                  : 'pb-[max(env(safe-area-inset-bottom),1rem)] md:mb-3',
              )}
            >
              {children}
            </div>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  )
}
