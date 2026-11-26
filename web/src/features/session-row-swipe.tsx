// Bidirectional swipe on a chat row (phone): swipe left reveals the trailing
// action (标为已读), swipe right the leading one (新一轮, or 复制引用 when the
// row cannot start a round). Vertical drags still scroll the list. Desktop
// uses the row context menu instead (session-list.tsx).
import { useRef, useState } from 'react'

import { Button } from '#/components/ui/button'
import { cn } from '#/lib/utils'

const OPEN = 104
const ARM = 48

export type RowSwipeAction = {
  label: string
  busyLabel?: string
  /** underlay colour */
  className: string
  testId?: string
  /** return true to close the swipe; false keeps it open (e.g. copy failed) */
  onAction: () => boolean | void | Promise<boolean | void>
}

export function SwipeActions({
  id,
  left,
  right,
  children,
}: {
  /** optional: `data-swipe=<id>` for tests / diagnostics */
  id?: string
  /** revealed by swiping right (sits under the leading edge) */
  left?: RowSwipeAction
  /** revealed by swiping left (sits under the trailing edge) */
  right?: RowSwipeAction
  children: React.ReactNode
}) {
  const [offset, setOffset] = useState(0)
  const offsetRef = useRef(0)
  const [dragging, setDragging] = useState(false)
  const [busySide, setBusySide] = useState<'left' | 'right' | null>(null)
  const start = useRef<{
    x: number
    y: number
    base: number
    axis?: 'x' | 'y'
  }>(null)
  if (!left && !right) return <>{children}</>

  const min = right ? -OPEN - 24 : 0
  const max = left ? OPEN + 24 : 0
  const openLeft = offset >= OPEN - 1
  const openRight = offset <= -OPEN + 1
  const moveTo = (next: number) => {
    offsetRef.current = next
    setOffset(next)
  }

  const run = async (side: 'left' | 'right', action: RowSwipeAction) => {
    setBusySide(side)
    try {
      const ok = await action.onAction()
      if (ok !== false) moveTo(0)
    } finally {
      setBusySide(null)
    }
  }

  const underlay = (
    side: 'left' | 'right',
    action: RowSwipeAction,
    open: boolean,
  ) => (
    <Button
      variant="plain"
      type="button"
      disabled={busySide !== null}
      tabIndex={open ? 0 : -1}
      aria-hidden={!open}
      data-testid={action.testId}
      onClick={() => void run(side, action)}
      className={cn(
        'absolute inset-y-0 flex items-center justify-center px-3 text-body font-semibold disabled:opacity-60',
        side === 'left' ? 'left-0' : 'right-0',
        action.className,
      )}
      style={{ width: OPEN }}
    >
      {busySide === side ? (action.busyLabel ?? action.label) : action.label}
    </Button>
  )

  return (
    <div className="relative overflow-hidden" data-swipe={id ?? ''}>
      {left ? underlay('left', left, openLeft) : null}
      {right ? underlay('right', right, openRight) : null}
      <div
        className="relative bg-brand-surface touch-pan-y"
        style={{
          transform: `translateX(${offset}px)`,
          transition: dragging ? 'none' : 'transform 180ms ease-out',
        }}
        // capture: ContextMenu.Trigger stopPropagation on touchstart would
        // otherwise hide the gesture from a bubbling listener
        onTouchStartCapture={(event) => {
          const touch = event.touches[0]
          start.current = { x: touch.clientX, y: touch.clientY, base: offset }
        }}
        onTouchMoveCapture={(event) => {
          const s = start.current
          if (!s) return
          const touch = event.touches[0]
          const dx = touch.clientX - s.x
          const dy = touch.clientY - s.y
          s.axis ??=
            Math.abs(dx) > Math.abs(dy) + 4
              ? 'x'
              : Math.abs(dy) > 6
                ? 'y'
                : undefined
          if (s.axis !== 'x') return
          setDragging(true)
          moveTo(Math.max(min, Math.min(max, s.base + dx)))
        }}
        onTouchEndCapture={() => {
          const s = start.current
          start.current = null
          setDragging(false)
          if (s?.axis !== 'x') return
          const now = offsetRef.current
          const wentLeft = now < s.base - ARM
          const wentRight = now > s.base + ARM
          if (right && (wentLeft || (s.base < 0 && now < -ARM))) {
            moveTo(-OPEN)
            return
          }
          if (left && (wentRight || (s.base > 0 && now > ARM))) {
            moveTo(OPEN)
            return
          }
          moveTo(0)
        }}
        onClickCapture={(event) => {
          if (offsetRef.current === 0) return
          event.preventDefault()
          event.stopPropagation()
          moveTo(0)
        }}
      >
        {children}
      </div>
    </div>
  )
}
