import { Input as BaseInput } from '@base-ui/react/input'
import type { ComponentProps } from 'react'

import { cn } from '#/lib/utils'

const looks = {
  /** dense desktop field */
  default:
    'min-h-8 w-full rounded-lg border border-brand-border bg-brand-soft px-2.5 text-meta text-brand-text outline-none transition focus:border-brand-running focus:ring-2 focus:ring-brand-running/20',
  /** phone form field: 44 px tall, 15 px text */
  field:
    'min-h-11 w-full rounded-xl bg-brand-surface px-3 text-body text-brand-text outline-none placeholder:text-brand-label focus-visible:ring-2 focus-visible:ring-brand-running/40 disabled:opacity-60',
  /** no chrome: sits inside a styled container (search box, composer) */
  bare: 'min-w-0 bg-transparent outline-none placeholder:text-brand-label',
}

export type InputProps = ComponentProps<typeof BaseInput> & {
  variant?: keyof typeof looks
}

/** text field (Base UI); eslint forbids a bare <input> outside components/ */
export function Input({
  className,
  variant = 'default',
  ...props
}: InputProps) {
  return <BaseInput className={cn(looks[variant], className)} {...props} />
}
