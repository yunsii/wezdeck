import { Select as BaseSelect } from '@base-ui/react/select'
import { Check, ChevronDown } from 'lucide-react'
import type { ComponentProps } from 'react'

import { cn } from '#/lib/utils'

export type SelectOption = { value: string; label: React.ReactNode }

export type SelectProps = Omit<
  ComponentProps<typeof BaseSelect.Root<string>>,
  'items' | 'children' | 'value' | 'onValueChange'
> & {
  className?: string
  value: string
  options: SelectOption[]
  onValueChange: (value: string) => void
  /** lg: a phone form field (15 px, 44 px tall) instead of the dense desktop one */
  size?: 'sm' | 'lg'
}

export function Select({
  value,
  options,
  onValueChange,
  className,
  size = 'sm',
  ...props
}: SelectProps) {
  const lg = size === 'lg'
  return (
    <BaseSelect.Root<string>
      {...props}
      value={value}
      onValueChange={(next) => onValueChange(next ?? '')}
    >
      <BaseSelect.Trigger
        className={cn(
          'inline-flex w-full items-center justify-between gap-2 rounded-md border border-brand-border bg-brand-soft px-2.5 text-left text-brand-text outline-none transition hover:border-brand-running focus:border-brand-running focus:ring-2 focus:ring-brand-running/20',
          // lg matches the phone fields beside it: borderless, on the surface
          lg
            ? 'min-h-11 rounded-[10px] border-transparent bg-brand-surface px-3 text-[15px]'
            : 'min-h-8 text-xs',
          className,
        )}
      >
        <BaseSelect.Value className="min-w-0 truncate">
          {(current) =>
            options.find((option) => option.value === current)?.label ?? ''
          }
        </BaseSelect.Value>
        <BaseSelect.Icon>
          <ChevronDown size={14} aria-hidden="true" />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        {/* above the z-50 bottom sheets a select can sit in */}
        <BaseSelect.Positioner sideOffset={4} className="z-[60]">
          {/* enter only (@starting-style): Base UI keeps a closed select popup
              mounted, and an exit transition left it in the DOM, unhidden */}
          <BaseSelect.Popup className="origin-[var(--transform-origin)] transition-[opacity,scale] duration-[var(--motion-short)] ease-[var(--ease-enter)] starting:scale-[0.96] starting:opacity-0 motion-reduce:starting:scale-100 z-30 min-w-40 overflow-hidden rounded-md border border-brand-border bg-brand-deck p-1 text-brand-text shadow-lg">
            <BaseSelect.List>
              {options.map((option) => (
                <BaseSelect.Item
                  key={option.value || '__empty'}
                  value={option.value}
                  className={cn(
                    'flex items-center justify-between gap-3 rounded px-2 text-brand-text outline-none data-highlighted:bg-brand-soft data-highlighted:text-brand-running',
                    lg ? 'min-h-11 text-[15px]' : 'min-h-8 text-xs',
                  )}
                >
                  <BaseSelect.ItemText>{option.label}</BaseSelect.ItemText>
                  <BaseSelect.ItemIndicator>
                    <Check size={14} aria-hidden="true" />
                  </BaseSelect.ItemIndicator>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  )
}
