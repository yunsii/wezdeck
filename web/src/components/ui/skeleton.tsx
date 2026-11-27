import { cn } from '#/lib/utils'

function Skeleton({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      aria-hidden="true"
      data-slot="skeleton"
      // Static placeholder (0 fps repaint): animating opacity spawns per-bar GPU
      // layers and animating background-color re-rasterizes the full HiDPI
      // scroller layer every vsync, flickering bottom tiles on tablet GPUs.
      className={cn('block rounded bg-brand-soft', className)}
      {...props}
    />
  )
}

export { Skeleton }
