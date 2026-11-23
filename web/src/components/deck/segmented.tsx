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
  dense = false,
}: {
  label: string
  value: TValue
  /** count: a number shown beside the label, smaller (filters) */
  options: Array<{ value: TValue; label: React.ReactNode; count?: number }>
  onChange: (value: TValue) => void
  className?: string
  /** four segments beside a button on a 320 px phone */
  dense?: boolean
}) {
  const counted = options.some((option) => option.count !== undefined)
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        'flex rounded-xl bg-[var(--segment-track)] p-[3px]',
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
              // never wrap: 「运行中 3」 broke in two on a 320 px phone
              'min-h-10 min-w-0 truncate rounded-lg whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-brand-running md:min-h-8 md:text-caption',
              // filters with counts size by their text (「已结束 80」 is wider
              // than 「等你 3」); equal thirds would cut the long one
              counted ? 'flex-auto' : 'flex-1',
              dense ? 'px-1 text-caption' : 'px-2 text-body',
              active
                ? 'bg-[var(--segment-thumb)] font-semibold text-brand-text shadow-[0_1px_2px_rgba(17,21,28,0.12)]'
                : 'text-brand-muted',
            )}
          >
            {option.label}
            {option.count !== undefined ? (
              <span className="ml-1 text-[0.85em] tabular-nums opacity-70">
                {option.count}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
