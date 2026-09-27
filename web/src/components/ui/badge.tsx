import { mergeProps } from '@base-ui/react/merge-props'
import { useRender } from '@base-ui/react/use-render'
import { cva } from 'class-variance-authority'
import type { VariantProps } from 'class-variance-authority'

import { cn } from '#/lib/utils'

const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-full border font-bold whitespace-nowrap [&>svg]:pointer-events-none',
  {
    variants: {
      variant: {
        default: 'border-brand-border text-brand-text',
        ready: 'border-brand-done/40 text-brand-done',
        warning: 'border-brand-waiting/45 text-brand-waiting',
        loading: 'border-brand-waiting/45 text-brand-waiting',
        offline: 'border-brand-error/45 text-brand-error',
        outline: 'border-brand-border text-brand-muted',
      },
      size: {
        default: 'h-7 px-2.5 text-[length:var(--text-meta)]',
        sm: 'h-6 px-2 text-[length:var(--text-kicker)]',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

function Badge({
  className,
  variant = 'default',
  size = 'default',
  render,
  ...props
}: useRender.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: 'span',
    props: mergeProps<'span'>(
      { className: cn(badgeVariants({ variant, size }), className) },
      props,
    ),
    render,
  })
}

export { Badge, badgeVariants }
