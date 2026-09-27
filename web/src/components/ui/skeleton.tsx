import { cn } from '#/lib/utils'

function Skeleton({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      aria-hidden="true"
      data-slot="skeleton"
      className={cn(
        'block animate-pulse rounded bg-brand-soft motion-reduce:animate-none',
        className,
      )}
      {...props}
    />
  )
}

export { Skeleton }
