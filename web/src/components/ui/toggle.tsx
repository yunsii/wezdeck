import { Toggle as TogglePrimitive } from '@base-ui/react/toggle'
import { cva } from 'class-variance-authority'
import type { VariantProps } from 'class-variance-authority'

import { cn } from '#/lib/utils'

const toggleVariants = cva(
  'inline-flex items-center justify-center gap-1 rounded font-medium whitespace-nowrap text-inherit transition focus-visible:ring-2 focus-visible:ring-brand-running disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default:
          'bg-transparent hover:bg-brand-running hover:text-brand-deck data-pressed:bg-brand-running data-pressed:text-brand-deck',
        outline: 'border border-brand-border bg-transparent',
        // Agent-attention tones — soft fill at rest, solid when pressed.
        // Mirrors landing-deck-tab is-running|waiting|done backgrounds.
        running:
          'border border-brand-running/40 bg-brand-running/10 text-brand-running hover:bg-brand-running/20 data-pressed:border-brand-running data-pressed:bg-brand-running data-pressed:text-brand-deck',
        waiting:
          'border border-brand-waiting/40 bg-brand-waiting/10 text-brand-waiting hover:bg-brand-waiting/20 data-pressed:border-brand-waiting data-pressed:bg-brand-waiting data-pressed:text-brand-deck',
        done: 'border border-brand-done/40 bg-brand-done/10 text-brand-done hover:bg-brand-done/20 data-pressed:border-brand-done data-pressed:bg-brand-done data-pressed:text-brand-deck',
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
