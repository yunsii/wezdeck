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
//   phone  a short value (≤ 16 chars: 不可用, a count, a version) sits on the
//          label's line, right-aligned, like the 我的 rows — stacking those
//          left a page of half-empty lines; a longer one (URL, path, id)
//          goes on top with the label in small grey under it; the row
//          lights while pressed
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
        'overflow-hidden rounded-xl bg-brand-surface md:grid md:grid-cols-[max-content_minmax(0,1fr)_auto] md:gap-x-4',
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
  // the toast shows what landed on the clipboard, not the row's name: a tap
  // copies the value, and "Copied <label>" read as if the label was copied
  const copy = (text: string) => {
    void copyText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1_200)
      const shown = text.length > 40 ? `${text.slice(0, 39)}…` : text
      toast(t`Copied: ${shown}`)
    })
  }
  const pair = `${label}: ${value}`
  const inline = value.length <= 16
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger
        render={<button type="button" />}
        onClick={() => copy(value)}
        data-field={label}
        className={cn(
          'group w-full px-3 py-2.5 md:pr-4 text-left outline-none select-none [-webkit-touch-callout:none]',
          inline
            ? 'flex min-h-12 items-baseline justify-between gap-3 md:grid md:min-h-0'
            : 'grid gap-y-0.5',
          'transition-colors active:bg-brand-soft data-[popup-open]:bg-brand-soft focus-visible:bg-brand-soft',
          'md:col-span-3 md:grid-cols-subgrid md:items-baseline md:py-2 md:hover:bg-brand-soft',
        )}
      >
        <span
          className={cn(
            'min-w-0 break-all text-brand-text md:col-start-2 md:row-start-1 md:text-left',
            inline && 'text-right text-brand-muted md:text-brand-text',
            mono
              ? 'font-mono text-caption md:text-meta'
              : 'text-body md:text-caption',
          )}
        >
          {value}
        </span>
        <span
          className={cn(
            'text-brand-label md:col-start-1 md:row-start-1 md:text-caption',
            // on one line the label is the row's name (ink, body size, first)
            // and the value reads secondary, as in the 我的 rows
            inline
              ? 'order-first shrink-0 text-body text-brand-text md:text-brand-label'
              : 'text-meta',
          )}
        >
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
            className="motion-pop min-w-40 rounded-xl border border-brand-edge bg-brand-surface p-1 text-body text-brand-text shadow-lg outline-none"
          >
            <ContextMenu.Item
              onClick={() => copy(value)}
              className="flex cursor-default items-center gap-2 rounded-lg px-3 py-2 outline-none data-[highlighted]:bg-brand-soft"
            >
              <Copy size={14} aria-hidden />
              {t`Copy value`}
            </ContextMenu.Item>
            <ContextMenu.Item
              onClick={() => copy(pair)}
              className="flex cursor-default items-center gap-2 rounded-lg px-3 py-2 outline-none data-[highlighted]:bg-brand-soft"
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
