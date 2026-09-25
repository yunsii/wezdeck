import { Button as BaseButton } from '@base-ui/react/button'
import { cva } from 'class-variance-authority'
import type { VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'

import { cn } from '#/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand-running disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-brand-running text-brand-deck hover:bg-brand-running/85',
        outline:
          'border border-brand-border bg-transparent text-brand-text hover:border-brand-running hover:text-brand-running',
        warning:
          'border border-brand-waiting bg-brand-waiting/10 text-brand-waiting hover:bg-brand-waiting/20',
        ghost: 'text-brand-muted hover:bg-brand-soft hover:text-brand-text',
      },
      size: {
        default: 'min-h-10 px-4 text-sm',
        sm: 'min-h-8 px-3 text-xs',
        icon: 'size-8',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

export type ButtonProps = ComponentProps<typeof BaseButton> &
  VariantProps<typeof buttonVariants>

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return (
    <BaseButton
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
}

export { buttonVariants }
