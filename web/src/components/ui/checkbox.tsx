import { Checkbox as BaseCheckbox } from '@base-ui/react/checkbox'
import { Check } from 'lucide-react'
import type { ComponentProps } from 'react'

import { cn } from '#/lib/utils'

export type CheckboxProps = ComponentProps<typeof BaseCheckbox.Root>

/** Base UI checkbox (role=checkbox); pair it with a <label> around it */
export function Checkbox({ className, ...props }: CheckboxProps) {
  return (
    <BaseCheckbox.Root
      className={cn(
        'inline-flex size-5 shrink-0 items-center justify-center rounded-[6px] border border-brand-border bg-brand-deck text-brand-deck outline-none focus-visible:ring-2 focus-visible:ring-brand-running data-checked:border-brand-text data-checked:bg-brand-text data-disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <BaseCheckbox.Indicator>
        <Check size={14} strokeWidth={3} aria-hidden />
      </BaseCheckbox.Indicator>
    </BaseCheckbox.Root>
  )
}
