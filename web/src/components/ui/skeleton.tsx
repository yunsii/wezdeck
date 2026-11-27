import { cn } from '#/lib/utils'

function Skeleton({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      aria-hidden="true"
      data-slot="skeleton"
      className={cn('skeleton-breathe block rounded', className)}
      {...props}
    />
  )
}

export { Skeleton }
