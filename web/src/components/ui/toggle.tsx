import { Toggle as TogglePrimitive } from '@base-ui/react/toggle'
import { cva } from 'class-variance-authority'
import type { VariantProps } from 'class-variance-authority'

import { cn } from '#/lib/utils'

const toggleVariants = cva(
  'inline-flex items-center justify-center gap-1 rounded font-medium whitespace-nowrap text-inherit transition hover:bg-brand-running hover:text-brand-deck focus-visible:ring-2 focus-visible:ring-brand-running data-pressed:bg-brand-running data-pressed:text-brand-deck disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-transparent',
        outline: 'border border-brand-border bg-transparent',
      },
      size: {
        default: 'min-h-7 px-1.75 text-xs',
        sm: 'min-h-7 px-1.75',
        icon: 'size-7',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

function Toggle({
  className,
  variant = 'default',
  size = 'default',
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size }), className)}
      {...props}
    />
  )
}

export { Toggle, toggleVariants }
