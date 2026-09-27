import { Input as BaseInput } from '@base-ui/react/input'
import type { ComponentProps } from 'react'

import { cn } from '#/lib/utils'

export type InputProps = ComponentProps<typeof BaseInput>

export function Input({ className, ...props }: InputProps) {
  return (
    <BaseInput
      className={cn(
        'min-h-8 w-full rounded-md border border-brand-border bg-brand-soft px-2.5 text-xs text-brand-text outline-none transition focus:border-brand-running focus:ring-2 focus:ring-brand-running/20',
        className,
      )}
      {...props}
    />
  )
}
