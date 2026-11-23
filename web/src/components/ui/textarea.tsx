import type { ComponentProps } from 'react'

import { cn } from '#/lib/utils'

const looks = {
  /** phone form field */
  field:
    'w-full rounded-[10px] bg-brand-surface px-3 py-2 text-[15px] text-brand-text outline-none placeholder:text-brand-label focus-visible:ring-2 focus-visible:ring-brand-running/40 disabled:opacity-60',
  /** no chrome: sits inside a styled container (the composer) */
  bare: 'bg-transparent outline-none placeholder:text-brand-label',
}

export type TextareaProps = ComponentProps<'textarea'> & {
  variant?: keyof typeof looks
}

/** multi-line text field; eslint forbids a bare <textarea> outside components/ */
export function Textarea({
  className,
  variant = 'field',
  ...props
}: TextareaProps) {
  return <textarea className={cn(looks[variant], className)} {...props} />
}
