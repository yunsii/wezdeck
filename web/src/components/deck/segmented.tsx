import { cn } from '#/lib/utils'

/**
 * Phone-first segmented control (iOS-style track + thumb): one tap, the
 * whole width, 44 px tall on touch. Used for filters and settings instead of
 * popover menus.
 */
export function Segmented<TValue extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string
  value: TValue
  options: Array<{ value: TValue; label: React.ReactNode }>
  onChange: (value: TValue) => void
  className?: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        'flex rounded-[12px] bg-[var(--segment-track)] p-[3px]',
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            data-value={option.value}
            onClick={() => onChange(option.value)}
            className={cn(
              'min-h-10 flex-1 rounded-[9px] px-2 text-[14px] outline-none focus-visible:ring-2 focus-visible:ring-brand-running md:min-h-8 md:text-[13px]',
              active
                ? 'bg-[var(--segment-thumb)] font-semibold text-brand-text shadow-[0_1px_2px_rgba(17,21,28,0.12)]'
                : 'text-brand-muted',
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
