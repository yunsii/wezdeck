// Overlay scrollbar host for list columns: native scroll feel, custom track
// that does not take layout width (no classic-scrollbar width jitter), hidden
// until hover / focus-within / scroll. Wraps OverlayScrollbars.
import 'overlayscrollbars/styles/overlayscrollbars.css'

import { OverlayScrollbarsComponent } from 'overlayscrollbars-react'
import type { OverlayScrollbarsComponentProps } from 'overlayscrollbars-react'

import { cn } from '#/lib/utils'

const defaults = {
  overflow: { x: 'hidden' as const, y: 'scroll' as const },
  scrollbars: {
    theme: 'os-theme-wezdeck',
    autoHide: 'leave' as const,
    autoHideDelay: 700,
    clickScroll: true,
  },
}

/**
 * Flex-friendly overlay scroller. Parent must give it a bounded height
 * (`min-h-0 flex-1` / `h-full`). Children scroll inside; the bar paints over
 * the content edge instead of stealing columns.
 */
export function OverlayScroll({
  className,
  options,
  children,
  ...rest
}: OverlayScrollbarsComponentProps) {
  const extra = options && typeof options === 'object' ? options : {}
  return (
    <OverlayScrollbarsComponent
      defer
      data-overlayscrollbars-initialize=""
      options={{
        ...defaults,
        ...extra,
        overflow: { ...defaults.overflow, ...extra.overflow },
        scrollbars: { ...defaults.scrollbars, ...extra.scrollbars },
      }}
      className={cn('h-full min-h-0', className)}
      {...rest}
    >
      {children}
    </OverlayScrollbarsComponent>
  )
}
