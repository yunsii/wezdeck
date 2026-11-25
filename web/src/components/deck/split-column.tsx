// The list column of a wide split (会话 / 工单): its head — the page title,
// the status filter, search — holds still above a divider, and only the list
// under it scrolls. The column is sticky beside the pane, which keeps the
// page scroll (the chat's pin-to-bottom depends on that). Head and body both
// reserve the scrollbar gutter, so their right edges line up whether or not
// the list overflows. The right margin matches the page's left padding
// (--page-x) with the gutter counted in — a thin desktop scrollbar takes
// 10 px (scrollbar.css): padding a full --page-x on top of it left the cards
// 10 px from the sidebar but 20 px from the divider (2026-11-25).
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
        'vt-split-list sticky top-4 flex h-[calc(100cqh-2rem)] min-h-0 flex-col [--split-pad:max(0px,calc(var(--page-x)-10px))]',
        className,
      )}
    >
      <div
        data-testid="split-head"
        className="grid shrink-0 gap-3 overflow-hidden border-b border-brand-edge px-0.5 pt-0.5 pb-3 pr-[var(--split-pad)] [scrollbar-gutter:stable]"
      >
        {head}
      </div>
      {/* overscroll contained: past its top or end the list used to chain
          the wheel into the page, scrolling the pane beside it */}
      <div className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto overscroll-contain pt-3 pr-[var(--split-pad)] pb-1 [scrollbar-gutter:stable]">
        {children}
      </div>
    </aside>
  )
}
