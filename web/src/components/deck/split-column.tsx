// The list column of a wide split (会话 / 工单): its head — the page title,
// the status filter, search — holds still above a divider, and only the list
// under it scrolls. OverlayScrollbars paint over the content edge (no classic
// gutter), so hover-show never shifts card width; left/right use the same
// --split-pad.
import { OverlayScroll } from '#/components/deck/overlay-scroll'
import { cn } from '#/lib/utils'

export function SplitColumn({
  label,
  head,
  className,
  children,
}: {
  label: string
  head: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  return (
    <aside
      aria-label={label}
      className={cn(
        'vt-split-list sticky top-4 flex h-[calc(100cqh-2rem)] min-h-0 flex-col [--split-pad:max(12px,var(--page-x))]',
        className,
      )}
    >
      <div
        data-testid="split-head"
        className="grid shrink-0 gap-3 overflow-hidden border-b border-brand-edge px-[var(--split-pad)] pt-0.5 pb-3"
      >
        {head}
      </div>
      {/* overscroll contained: past its top or end the list used to chain
          the wheel into the page, scrolling the pane beside it */}
      <div className="min-h-0 flex-1">
        <OverlayScroll className="overscroll-contain">
          <div
            data-testid="split-body"
            className="grid content-start gap-0 pt-3 pb-0"
          >
            {children}
          </div>
        </OverlayScroll>
      </div>
    </aside>
  )
}
