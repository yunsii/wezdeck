import { Popover as PopoverPrimitive } from '@base-ui/react/popover'

function Popover({ ...props }: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  side = 'bottom',
  sideOffset = 8,
  children,
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<PopoverPrimitive.Positioner.Props, 'side' | 'sideOffset'>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        className="z-30"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={
            'rounded-md border border-brand-border bg-brand-surface p-1 text-brand-text shadow-lg focus-visible:ring-2 focus-visible:ring-brand-running ' +
            (className ?? '')
          }
          {...props}
        >
          {children}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverContent, PopoverTrigger }
