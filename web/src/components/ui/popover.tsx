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
          // portalled out of the page: bring the ink tokens along (without
          // them it fell back to the old theme's blue)
          data-deck
          className={
            'motion-pop rounded-[14px] border border-brand-edge bg-brand-surface p-1.5 text-brand-text shadow-[0_12px_32px_-12px_rgb(0_0_0/0.3)] outline-none ' +
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
