import { ContextMenu } from '@base-ui/react/context-menu'
import { useLingui } from '@lingui/react/macro'
import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { copyText } from '#/lib/clipboard'
import { cn } from '#/lib/utils'

// Label / value rows you read and copy (session info, usage), the Telegram
// profile way (tweb peerProfile.tsx + rowTsx.tsx): the whole row is one
// target — a tap or click copies the value, a right click or a long press
// opens a menu (copy the value / copy "label: value").
//   phone  value on top, the label in small grey under it: they read as a
//          pair, not two columns a thumb apart; the row lights while pressed
//   wide   two columns kept for scanning, the label column only as wide as
//          the longest label in the list (subgrid); hovering lights the row
//          and shows the copy icon

/** a card of Field rows; on a wide screen they share one label column */
export function FieldList({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-[14px] bg-brand-surface md:grid md:grid-cols-[max-content_minmax(0,1fr)_auto] md:gap-x-4',
        className,
      )}
    >
      {children}
    </div>
  )
}

export function Field({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  const { t } = useLingui()
  const [copied, setCopied] = useState(false)
  const copy = (text: string, what: string) => {
    void copyText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1_200)
      toast(t`Copied ${what}`)
    })
  }
  const pair = `${label}: ${value}`
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger
        render={<button type="button" />}
        onClick={() => copy(value, label)}
        data-field={label}
        className={cn(
          'group grid w-full gap-y-0.5 px-3 py-2.5 md:pr-4 text-left outline-none select-none [-webkit-touch-callout:none]',
          'transition-colors active:bg-brand-soft data-[popup-open]:bg-brand-soft focus-visible:bg-brand-soft',
          'md:col-span-3 md:grid-cols-subgrid md:items-baseline md:py-2 md:hover:bg-brand-soft',
        )}
      >
        <span
          className={cn(
            'min-w-0 break-all text-brand-text md:col-start-2 md:row-start-1',
            mono
              ? 'font-mono text-[13px] md:text-[12px]'
              : 'text-[15px] md:text-[13px]',
          )}
        >
          {value}
        </span>
        <span className="text-[12px] text-brand-label md:col-start-1 md:row-start-1 md:text-[13px]">
          {label}
        </span>
        <span
          aria-hidden
          className="hidden self-center text-brand-label md:col-start-3 md:row-start-1 md:block"
        >
          {copied ? (
            <Check size={13} className="text-brand-done" />
          ) : (
            <Copy
              size={13}
              className="opacity-0 transition-opacity group-hover:opacity-100"
            />
          )}
        </span>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-[60]">
          <ContextMenu.Popup
            // portalled out of the console: bring its colour tokens along
            data-deck
            className="min-w-40 rounded-[12px] border border-brand-edge bg-brand-surface p-1 text-[14px] text-brand-text shadow-lg outline-none"
          >
            <ContextMenu.Item
              onClick={() => copy(value, label)}
              className="flex cursor-default items-center gap-2 rounded-[8px] px-3 py-2 outline-none data-[highlighted]:bg-brand-soft"
            >
              <Copy size={14} aria-hidden />
              {t`Copy value`}
            </ContextMenu.Item>
            <ContextMenu.Item
              onClick={() => copy(pair, label)}
              className="flex cursor-default items-center gap-2 rounded-[8px] px-3 py-2 outline-none data-[highlighted]:bg-brand-soft"
            >
              <Copy size={14} aria-hidden />
              {t`Copy “${label}: …”`}
            </ContextMenu.Item>
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
