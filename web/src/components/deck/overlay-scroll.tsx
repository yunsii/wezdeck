// Desktop list-column scroller: OverlayScrollbars (hover-show, no layout-width
// jitter). Touch / coarse pointers keep a plain overflow div — phones already
// use OS overlay bars, and SplitColumn is wide-only anyway; this guard also
// keeps the library off the mobile render path when reused elsewhere.
import { lazy, Suspense } from 'react'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'

import { useMediaQuery } from '#/lib/use-media'
import { cn } from '#/lib/utils'

const OverlayScrollbarsLazy = lazy(async () => {
  await import('overlayscrollbars/styles/overlayscrollbars.css')
  const { OverlayScrollbarsComponent } = await import('overlayscrollbars-react')
  return { default: OverlayScrollbarsComponent }
})

const defaults = {
  overflow: { x: 'hidden' as const, y: 'scroll' as const },
  scrollbars: {
    theme: 'os-theme-wezdeck',
    autoHide: 'leave' as const,
    autoHideDelay: 700,
    clickScroll: true,
  },
}

type NativeProps = ComponentPropsWithoutRef<'div'> & { children?: ReactNode }

function NativeScroll({ className, children, ...rest }: NativeProps) {
  return (
    <div
      className={cn(
        'h-full min-h-0 overflow-y-auto overscroll-contain',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  )
}

/**
 * Flex-friendly scroller. Parent must give a bounded height (`min-h-0 flex-1`
 * / `h-full`). On fine-pointer desktops: OverlayScrollbars. On touch / coarse
 * pointers: native overflow (no library init).
 */
export function OverlayScroll({ className, children, ...rest }: NativeProps) {
  // Phone-first: assume touch until matchMedia says otherwise, so SSR / first
  // paint never mounts OverlayScrollbars on a phone.
  const desktopPointer = useMediaQuery(
    '(hover: hover) and (pointer: fine)',
    false,
  )
  if (!desktopPointer) {
    return (
      <NativeScroll className={className} {...rest}>
        {children}
      </NativeScroll>
    )
  }
  return (
    <Suspense
      fallback={
        <NativeScroll className={className} {...rest}>
          {children}
        </NativeScroll>
      }
    >
      <OverlayScrollbarsLazy
        {...rest}
        defer
        data-overlayscrollbars-initialize=""
        options={defaults}
        className={cn('h-full min-h-0', className)}
      >
        {children}
      </OverlayScrollbarsLazy>
    </Suspense>
  )
}
