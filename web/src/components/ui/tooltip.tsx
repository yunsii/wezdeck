import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip'

export function Tooltip({
  children,
  content,
}: {
  children: React.ReactNode
  content: string
}) {
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger
        className="relative m-0 inline-flex cursor-help items-center justify-center border-0 bg-transparent p-0 align-[-0.15em] text-brand-muted outline-offset-2 hover:text-brand-running focus-visible:text-brand-running focus-visible:outline-2 focus-visible:outline-brand-running"
        aria-label={content}
      >
        {children}
      </BaseTooltip.Trigger>
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side="top" sideOffset={8}>
          <BaseTooltip.Popup className="z-20 w-[min(calc(var(--spacing)*70),70vw)] rounded-md border border-brand-border bg-brand-surface px-2.5 py-2 text-xs leading-snug font-normal text-brand-text shadow-lg">
            {content}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  )
}
