// The list column of a wide split (会话 / 工单): its head — the page title,
// the status filter, search — holds still above a divider, and only the list
// under it scrolls. OverlayScrollbars paint over the content edge (no classic
// gutter), so hover-show never shifts card width; left/right use the same
// --split-pad.
import { useEffect, useRef } from 'react'

import { OverlayScroll } from '#/components/deck/overlay-scroll'
import { trace } from '#/lib/client-trace'
import { cn } from '#/lib/utils'

const USER_SCROLL_WINDOW_MS = 600

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
  const asideRef = useRef<HTMLElement>(null)

  // Observe unexpected scrollTop jumps inside the split list (not driven by
  // recent wheel / touch / pointer input) so list flicker leaves a trace.
  useEffect(() => {
    const aside = asideRef.current
    if (!aside) return
    let lastUserInput = 0
    let lastTop = -1
    let lastHeight = -1
    let lastTraceAt = 0
    const markUser = () => {
      lastUserInput = performance.now()
    }
    const onScroll = (event: Event) => {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      const top = Math.round(target.scrollTop)
      const height = target.scrollHeight
      const now = performance.now()
      const user = now - lastUserInput < USER_SCROLL_WINDOW_MS
      if (
        lastTop >= 0 &&
        !user &&
        Math.abs(top - lastTop) >= 4 &&
        now - lastTraceAt >= 200
      ) {
        lastTraceAt = now
        trace('split-list-scroll', {
          label,
          from: lastTop,
          to: top,
          height,
          prevHeight: lastHeight,
        })
      }
      lastTop = top
      lastHeight = height
    }
    aside.addEventListener('wheel', markUser, { passive: true, capture: true })
    aside.addEventListener('touchstart', markUser, {
      passive: true,
      capture: true,
    })
    aside.addEventListener('pointerdown', markUser, {
      passive: true,
      capture: true,
    })
    aside.addEventListener('scroll', onScroll, { passive: true, capture: true })
    return () => {
      aside.removeEventListener('wheel', markUser, { capture: true })
      aside.removeEventListener('touchstart', markUser, { capture: true })
      aside.removeEventListener('pointerdown', markUser, { capture: true })
      aside.removeEventListener('scroll', onScroll, { capture: true })
    }
  }, [label])

  return (
    <aside
      ref={asideRef}
      aria-label={label}
      className={cn(
        'vt-split-list sticky top-0 flex h-[100cqh] min-h-0 w-full flex-col will-change-transform [--split-pad:var(--page-x)]',
        className,
      )}
    >
      <div
        data-testid="split-head"
        className="grid shrink-0 gap-3 overflow-hidden px-[var(--split-pad)] py-2.5 shadow-[inset_0_-1px_0_var(--brand-edge)]"
      >
        {head}
      </div>
      {/* overscroll contained: past its top or end the list used to chain
          the wheel into the page, scrolling the pane beside it */}
      <div className="min-h-0 flex-1">
        <OverlayScroll className="overscroll-contain">
          <div
            data-testid="split-body"
            className="grid content-start gap-0 pt-0 pb-0"
          >
            {children}
          </div>
        </OverlayScroll>
      </div>
    </aside>
  )
}
