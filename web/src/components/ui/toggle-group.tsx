import { ToggleGroup as ToggleGroupPrimitive } from '@base-ui/react/toggle-group'
import { cva } from 'class-variance-authority'
import type { VariantProps } from 'class-variance-authority'

import { cn } from '#/lib/utils'

const toggleGroupVariants = cva(
  'inline-flex items-center gap-0.5 text-brand-muted',
)

function ToggleGroup({
  className,
  ...props
}: ToggleGroupPrimitive.Props & VariantProps<typeof toggleGroupVariants>) {
  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      className={cn(toggleGroupVariants(), className)}
      {...props}
    />
  )
}

export { ToggleGroup }
