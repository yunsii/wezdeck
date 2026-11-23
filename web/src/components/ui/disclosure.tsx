import { Collapsible as BaseCollapsible } from '@base-ui/react/collapsible'
import { ChevronRight } from 'lucide-react'
import type { ComponentProps } from 'react'

import { cn } from '#/lib/utils'

/**
 * A titled section that folds (instead of a bare <details>, which eslint
 * forbids outside components/): the title row with a › that turns, the
 * content below while open. The trigger is a `group`, so the title can react
 * to the state with `group-data-[panel-open]:…`.
 */
export function Disclosure({
  title,
  chevron = true,
  className,
  triggerClassName,
  panelClassName,
  children,
  ...props
}: Omit<ComponentProps<typeof BaseCollapsible.Root>, 'title' | 'children'> & {
  title: React.ReactNode
  /** false: the title lays out its own row (a divider line, say) */
  chevron?: boolean
  className?: string
  triggerClassName?: string
  panelClassName?: string
  children: React.ReactNode
}) {
  return (
    <BaseCollapsible.Root className={className} {...props}>
      <BaseCollapsible.Trigger
        className={cn(
          'group flex w-full cursor-pointer items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand-running',
          chevron && 'min-h-11 justify-between text-sm font-semibold',
          triggerClassName,
        )}
      >
        {chevron ? <span className="min-w-0">{title}</span> : title}
        {chevron ? (
          <ChevronRight
            size={16}
            aria-hidden
            className="shrink-0 text-brand-label transition group-data-[panel-open]:rotate-90"
          />
        ) : null}
      </BaseCollapsible.Trigger>
      <BaseCollapsible.Panel className={panelClassName}>
        {children}
      </BaseCollapsible.Panel>
    </BaseCollapsible.Root>
  )
}
