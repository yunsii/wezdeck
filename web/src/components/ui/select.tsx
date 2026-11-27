import { Select as BaseSelect } from '@base-ui/react/select'
import { Check, ChevronDown } from 'lucide-react'
import type { ComponentProps } from 'react'

import { cn } from '#/lib/utils'

export type SelectOption = {
  value: string
  label: React.ReactNode
  icon?: React.ReactNode
  disabled?: boolean
}

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
  /** names the trigger (the combobox); on Root it named nothing */
  'aria-label'?: string
}

export function Select({
  value,
  options,
  onValueChange,
  className,
  size = 'sm',
  'aria-label': ariaLabel,
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
        aria-label={ariaLabel}
        className={cn(
          'inline-flex w-full items-center justify-between gap-2 rounded-lg border border-brand-border bg-brand-soft px-2.5 text-left text-brand-text outline-none transition hover:border-brand-running focus:border-brand-running focus:ring-2 focus:ring-brand-running/20 data-popup-open:border-brand-running data-popup-open:ring-2 data-popup-open:ring-brand-running/20',
          // lg matches the phone fields beside it: borderless, on the surface
          lg
            ? 'min-h-11 rounded-xl border-transparent bg-brand-surface px-3 text-body'
            : 'min-h-8 text-meta',
          className,
        )}
      >
        <BaseSelect.Value className="min-w-0 flex-1">
          {(current) => {
            const option = options.find((item) => item.value === current)
            return (
              <span className="flex min-w-0 items-center gap-2">
                {option?.icon ? (
                  <span aria-hidden className="inline-flex shrink-0">
                    {option.icon}
                  </span>
                ) : null}
                <span className="min-w-0 truncate">{option?.label ?? ''}</span>
              </span>
            )
          }}
        </BaseSelect.Value>
        <BaseSelect.Icon>
          <ChevronDown size={14} aria-hidden="true" />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        {/* above the z-50 bottom sheets a select can sit in; disable
            alignItemWithTrigger so Base UI keeps Floating UI's side/align
            placement and injects --anchor-width on mouse clicks too */}
        <BaseSelect.Positioner
          alignItemWithTrigger={false}
          side="bottom"
          align="start"
          sideOffset={6}
          className={cn(
            'z-[60] max-w-[var(--available-width)]',
            lg ? 'w-[var(--anchor-width)]' : 'min-w-[var(--anchor-width)]',
          )}
        >
          {/* enter only (@starting-style): Base UI keeps a closed select popup
              mounted, and an exit transition left it in the DOM, unhidden */}
          <BaseSelect.Popup
            data-deck
            className={cn(
              'origin-[var(--transform-origin)] transition-[opacity,scale] duration-[var(--motion-short)] ease-[var(--ease-enter)] starting:scale-[0.96] starting:opacity-0 motion-reduce:starting:scale-100 z-30 max-h-[min(22rem,calc(100dvh-12rem))] w-full overflow-y-auto rounded-xl border border-brand-edge bg-brand-surface p-1.5 text-brand-text shadow-[0_14px_32px_rgb(0_0_0/0.28)]',
              !lg && 'min-w-40',
            )}
          >
            <BaseSelect.List>
              {options.map((option) => (
                <BaseSelect.Item
                  key={option.value || '__empty'}
                  value={option.value}
                  disabled={option.disabled}
                  className={cn(
                    'flex items-center justify-between gap-3 rounded-lg px-3 text-brand-text outline-none data-disabled:opacity-40 data-highlighted:bg-brand-soft data-highlighted:text-brand-running data-selected:bg-brand-soft',
                    lg ? 'min-h-11 text-body' : 'min-h-8 text-meta',
                  )}
                >
                  {option.icon ? (
                    <span aria-hidden className="inline-flex shrink-0">
                      {option.icon}
                    </span>
                  ) : null}
                  <BaseSelect.ItemText className="min-w-0 flex-1 truncate">
                    {option.label}
                  </BaseSelect.ItemText>
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
