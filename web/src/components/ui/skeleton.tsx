import { cn } from '#/lib/utils'

function Skeleton({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      aria-hidden="true"
      data-slot="skeleton"
      // Static bar — always group bars inside ONE <SkeletonGroup> so the GPU
      // composites a single opacity layer at 0 CPU repaint instead of N layers
      // per bar or full-scroller background-color re-rasterization.
      className={cn('skeleton-bar block rounded', className)}
      {...props}
    />
  )
}

function SkeletonGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton-group"
      className={cn('skeleton-pulse', className)}
      {...props}
    />
  )
}

export { Skeleton, SkeletonGroup }
