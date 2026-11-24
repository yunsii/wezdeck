// The status filter row of 会话 / 工单 (and the search under it), kept in
// view while the list scrolls. A phone sticks it to the page scroll below
// the safe area, edge to edge over the page gutter; a wide split sticks it
// to the top of the list column's own scroll. The page tone behind it, a
// touch translucent like the session header, so rows slide under cleanly.
import { cn } from '#/lib/utils'

export function StickyBar({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <div
      data-testid="sticky-bar"
      className={cn(
        'sticky top-[env(safe-area-inset-top)] z-20 -mx-[var(--page-x)] -my-1.5 grid gap-3 bg-brand-deck/95 px-[var(--page-x)] py-1.5 backdrop-blur md:top-0 md:mx-0 md:px-0',
        className,
      )}
    >
      {children}
    </div>
  )
}
