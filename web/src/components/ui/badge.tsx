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
        // Tinted fills match local interactive chips (Button warning /
        // overview alerts): border + soft bg + semantic text.
        default: 'border-brand-border bg-brand-soft text-brand-text',
        ready: 'border-brand-done/40 bg-brand-done/10 text-brand-done',
        warning:
          'border-brand-waiting/45 bg-brand-waiting/10 text-brand-waiting',
        loading:
          'border-brand-running/45 bg-brand-running/10 text-brand-running',
        offline: 'border-brand-error/45 bg-brand-error/10 text-brand-error',
        outline: 'border-brand-border bg-transparent text-brand-muted',
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
