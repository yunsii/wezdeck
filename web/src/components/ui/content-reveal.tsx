// Reusable skeleton -> content crossfade primitive.
// Keeps the exiting skeleton overlapped in the same `grid-area: 1/1` cell for
// 110 ms while fading `1 -> 0` as the resolved content settles in (`0.35 -> 1`),
// so placeholder bars dissolve into content instead of hard-unmounting.
// Fast loads that never showed a skeleton skip the exit overlay completely.
import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { cn } from '#/lib/utils'

const EXIT_MS = 110

export function ContentReveal({
  loading,
  pending = false,
  skeleton,
  children,
  enterClass = 'content-enter',
  className,
}: {
  /** Whether the loading skeleton is currently active (e.g. from useDelayedLoading). */
  loading: boolean
  /** True while the request is still in flight before `loading` turns true (renders nothing). */
  pending?: boolean
  skeleton: ReactNode
  children: ReactNode
  /** CSS animation class applied to the incoming content slot. */
  enterClass?: string
  className?: string
}) {
  const [exitingSkeleton, setExitingSkeleton] = useState(false)
  const wasLoadingRef = useRef(loading)

  useLayoutEffect(() => {
    const prev = wasLoadingRef.current
    wasLoadingRef.current = loading
    if (prev && !loading) {
      setExitingSkeleton(true)
      const timer = setTimeout(() => setExitingSkeleton(false), EXIT_MS)
      return () => clearTimeout(timer)
    }
    if (loading) {
      setExitingSkeleton(false)
    }
  }, [loading])

  if (loading) {
    return (
      <div className={cn('grid w-full min-w-0', className)}>
        <div className="col-start-1 row-start-1 min-w-0">{skeleton}</div>
      </div>
    )
  }

  if (pending) return null

  return (
    <div className={cn('grid w-full min-w-0', className)}>
      <div className={cn('col-start-1 row-start-1 min-w-0', enterClass)}>
        {children}
      </div>
      {exitingSkeleton ? (
        <div
          aria-hidden="true"
          data-content-reveal-exit="true"
          className="content-exit pointer-events-none col-start-1 row-start-1 min-w-0"
        >
          {skeleton}
        </div>
      ) : null}
    </div>
  )
}
