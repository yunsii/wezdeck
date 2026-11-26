// The list column of a wide split (会话 / 工单): its head — the page title,
// the status filter, search — holds still above a divider, and only the list
// under it scrolls. The column is sticky beside the pane, which keeps the
// page scroll (the chat's pin-to-bottom depends on that). Head and body use
// the same horizontal pad on both sides (scrollbar-gutter:stable already
// reserves the classic scrollbar), so skeleton and loaded cards share one
// inset and do not sit flush on the divider.
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
        className="grid shrink-0 gap-3 overflow-hidden border-b border-brand-edge px-[var(--split-pad)] pt-0.5 pb-3 [scrollbar-gutter:stable]"
      >
        {head}
      </div>
      {/* overscroll contained: past its top or end the list used to chain
          the wheel into the page, scrolling the pane beside it */}
      <div className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto overscroll-contain px-[var(--split-pad)] pt-3 pb-1 [scrollbar-gutter:stable]">
        {children}
      </div>
    </aside>
  )
}
