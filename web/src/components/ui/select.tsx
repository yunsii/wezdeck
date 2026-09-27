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
}

export function Select({
  value,
  options,
  onValueChange,
  className,
  ...props
}: SelectProps) {
  return (
    <BaseSelect.Root<string>
      {...props}
      value={value}
      onValueChange={(next) => onValueChange(next ?? '')}
    >
      <BaseSelect.Trigger
        className={cn(
          'inline-flex min-h-8 w-full items-center justify-between gap-2 rounded-md border border-brand-border bg-brand-soft px-2.5 text-left text-xs text-brand-text outline-none transition hover:border-brand-running focus:border-brand-running focus:ring-2 focus:ring-brand-running/20',
          className,
        )}
      >
        <BaseSelect.Value>
          {(current) =>
            options.find((option) => option.value === current)?.label ?? ''
          }
        </BaseSelect.Value>
        <BaseSelect.Icon>
          <ChevronDown size={14} aria-hidden="true" />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner sideOffset={4}>
          <BaseSelect.Popup className="z-30 min-w-40 overflow-hidden rounded-md border border-brand-border bg-brand-deck p-1 text-brand-text shadow-lg">
            <BaseSelect.List>
              {options.map((option) => (
                <BaseSelect.Item
                  key={option.value || '__empty'}
                  value={option.value}
                  className="flex min-h-8 items-center justify-between gap-3 rounded px-2 text-xs text-brand-text outline-none data-highlighted:bg-brand-soft data-highlighted:text-brand-running"
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
