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
      <BaseTooltip.Trigger className="info-tip-trigger" aria-label={content}>
        {children}
      </BaseTooltip.Trigger>
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side="top" sideOffset={8}>
          <BaseTooltip.Popup className="info-tip-popup">
            {content}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  )
}
