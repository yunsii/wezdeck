import { Collapsible as BaseCollapsible } from '@base-ui/react/collapsible'
import { ChevronRight } from 'lucide-react'
import type { ComponentProps } from 'react'

import { cn } from '#/lib/utils'

/**
 * A titled section that folds (instead of a bare <details>, which eslint
 * forbids outside components/): the title row with a › that turns, the
 * content below while open. The trigger is a `group`, so the title can react
 * to the state with `group-data-[panel-open]:…`. `aside` follows the title
 * (wrapping under a title that fills the row), outside the trigger (a control there would otherwise be a
 * button inside a button); the panel below keeps the full width.
 */
export function Disclosure({
  title,
  chevron = true,
  className,
  triggerClassName,
  panelClassName,
  aside,
  children,
  ...props
}: Omit<ComponentProps<typeof BaseCollapsible.Root>, 'title' | 'children'> & {
  title: React.ReactNode
  /** a control at the title row's end, beside (not inside) the trigger */
  aside?: React.ReactNode
  /** false: the title lays out its own row (a divider line, say) */
  chevron?: boolean
  className?: string
  triggerClassName?: string
  panelClassName?: string
  children: React.ReactNode
}) {
  const trigger = (
    <BaseCollapsible.Trigger
      className={cn(
        'group flex w-full cursor-pointer items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand-running',
        chevron && 'min-h-11 justify-between text-body font-semibold',
        triggerClassName,
      )}
    >
      {chevron ? <span className="min-w-0">{title}</span> : title}
      {chevron ? (
        <ChevronRight
          size={16}
          aria-hidden
          className="shrink-0 text-brand-label transition-transform duration-[var(--motion-medium)] ease-[var(--ease-standard)] group-data-[panel-open]:rotate-90"
        />
      ) : null}
    </BaseCollapsible.Trigger>
  )
  return (
    <BaseCollapsible.Root className={className} {...props}>
      {aside ? (
        // flows: the aside follows the title, and wraps under it when the
        // title needs the whole row (a long command) instead of squeezing it
        <div className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1">
          <div className="max-w-full min-w-0 flex-initial">{trigger}</div>
          {aside}
        </div>
      ) : (
        trigger
      )}
      <BaseCollapsible.Panel className="motion-collapse">
        <div className={panelClassName}>{children}</div>
      </BaseCollapsible.Panel>
    </BaseCollapsible.Root>
  )
}
