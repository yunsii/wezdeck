// The list column of a wide split (会话 / 工单): its head — the page title,
// the status filter, search — holds still above a divider, and only the list
// under it scrolls. The column is sticky beside the pane, which keeps the
// page scroll (the chat's pin-to-bottom depends on that). Head and body both
// reserve the scrollbar gutter, so their right edges line up whether or not
// the list overflows.
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
        'vt-split-list sticky top-4 flex h-[calc(100cqh-2rem)] min-h-0 flex-col',
        className,
      )}
    >
      <div
        data-testid="split-head"
        className="grid shrink-0 gap-3 overflow-hidden border-b border-brand-edge px-0.5 pt-0.5 pr-[var(--page-x)] pb-3 [scrollbar-gutter:stable]"
      >
        {head}
      </div>
      <div className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto pt-3 pr-[var(--page-x)] pb-1 [scrollbar-gutter:stable]">
        {children}
      </div>
    </aside>
  )
}
