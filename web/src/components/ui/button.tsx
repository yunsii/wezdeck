import { Button as BaseButton } from '@base-ui/react/button'
import { cva } from 'class-variance-authority'
import type { VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'

import { cn } from '#/lib/utils'

// Every clickable in the app is this Button (eslint forbids a bare <button>
// outside components/): one focus ring and disabled state everywhere.
// default / outline / warning / ghost bring a shape (inline-flex, centred);
// solid / key / link are only a skin — the caller's classes lay it out, so a
// grid option card stays left-aligned and wraps. `plain` adds nothing.
const shape =
  'inline-flex items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap'

const buttonVariants = cva(
  'transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand-running disabled:pointer-events-none disabled:opacity-40',
  {
    variants: {
      variant: {
        default: `${shape} bg-brand-running text-brand-deck hover:bg-brand-running/85`,
        /** the dark call to action: 发送 / 创建 / 提交答案 */
        solid:
          'key-press rounded-xl bg-brand-text font-semibold text-brand-deck',
        /** a key on the deck surface: options, toolbar chips */
        key: 'key-press rounded-xl border border-brand-edge bg-brand-deck text-brand-text',
        outline: `${shape} border border-brand-border bg-transparent text-brand-text hover:border-brand-running hover:text-brand-running`,
        warning: `${shape} border border-brand-waiting bg-brand-waiting/10 text-brand-waiting hover:bg-brand-waiting/20`,
        ghost: `${shape} text-brand-muted hover:bg-brand-soft hover:text-brand-text`,
        /** a quiet text action inside a row: 检查更新 */
        link: 'text-brand-running',
        plain: '',
      },
      size: {
        default: 'min-h-10 px-4 text-body',
        sm: 'min-h-8 px-3 text-meta',
        /** phone touch target */
        lg: 'min-h-12 px-3 text-body',
        md: 'min-h-11 px-3 text-body',
        icon: 'size-8',
        /** round icon button in a header or sheet */
        round: 'size-10 rounded-full',
        none: '',
      },
    },
    compoundVariants: [
      { variant: 'link', size: 'default', className: 'min-h-0 px-0 text-body' },
    ],
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

export type ButtonProps = ComponentProps<typeof BaseButton> &
  VariantProps<typeof buttonVariants>

export function Button({
  className,
  variant,
  size,
  nativeButton,
  render,
  ...props
}: ButtonProps) {
  return (
    <BaseButton
      className={cn(
        buttonVariants({
          variant,
          size: size ?? (variant === 'plain' ? 'none' : undefined),
        }),
        className,
      )}
      nativeButton={nativeButton ?? render === undefined}
      render={render}
      {...props}
    />
  )
}

export { buttonVariants }
