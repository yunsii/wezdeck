import { useLingui } from '@lingui/react/macro'
import {
  History,
  ImagePlus,
  Plus,
  Sparkles,
  SquareSlash,
  Trash2,
} from 'lucide-react'
import { useState } from 'react'

import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Sheet } from '#/components/ui/sheet'
import { trace } from '#/lib/client-trace'
import { DeferredMenuItem } from './session-deferred-menu-item'
import {
  SessionDeliveryOptions,
  SessionSendTimingRow,
} from './session-delivery-options'
import type { DeliveryPolicy } from './session-delivery-options'

const row =
  'flex min-h-12 w-full items-center gap-3 border-b border-brand-edge px-2 text-left text-body text-brand-text last:border-b-0'

export function ComposerTools({
  writable,
  canPickImage,
  hasCommands,
  hasSkills,
  hasDraft,
  unsettledCount = 0,
  deferredCount = 0,
  onOpenDeferred,
  onPickImage,
  onCommands,
  onSkills,
  onSentHistory,
  onClear,
  deliveryPolicy = 'immediate',
  onDeliveryPolicy,
}: {
  writable: boolean
  canPickImage: boolean
  hasCommands: boolean
  hasSkills: boolean
  hasDraft: boolean
  unsettledCount?: number
  deferredCount?: number
  onOpenDeferred?: () => void
  onPickImage: (files: FileList | null) => void
  onCommands: () => void
  onSkills: () => void
  onSentHistory?: () => void
  onClear: () => void
  deliveryPolicy?: DeliveryPolicy
  onDeliveryPolicy?: (policy: DeliveryPolicy) => void
}) {
  const { t } = useLingui()
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'actions' | 'delivery'>('actions')
  const close = () => {
    setOpen(false)
    setView('actions')
  }
  return (
    <>
      <Button
        variant="plain"
        type="button"
        data-testid="composer-tools-button"
        aria-label={t`Message actions`}
        aria-haspopup="dialog"
        title={t`Message actions`}
        onClick={() => {
          trace('session-controls', { action: 'open', type: 'composer' })
          setOpen(true)
        }}
        className="relative absolute bottom-1.5 left-1.5 inline-flex size-10 items-center justify-center rounded-full text-brand-muted"
      >
        <Plus size={19} aria-hidden />
        {unsettledCount + deferredCount > 0 ? (
          <span
            aria-hidden
            className="absolute top-1.5 right-1.5 size-2 rounded-full bg-brand-waiting"
          />
        ) : null}
      </Button>
      <Sheet
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setView('actions')
        }}
        title={view === 'delivery' ? t`Send timing` : t`Message actions`}
        onBack={view === 'delivery' ? () => setView('actions') : undefined}
        testId="composer-tools"
        write
      >
        {view === 'delivery' && onDeliveryPolicy ? (
          <SessionDeliveryOptions
            value={deliveryPolicy}
            onChange={(policy) => {
              onDeliveryPolicy(policy)
              trace('session-controls', { action: 'delivery-policy', policy })
              close()
            }}
          />
        ) : (
          <div className="grid px-4">
            {writable && canPickImage ? (
              <label className={`${row} cursor-pointer`}>
                <ImagePlus size={19} aria-hidden className="text-brand-muted" />
                {t`Images`}
                <Input
                  variant="bare"
                  type="file"
                  accept="image/*"
                  multiple
                  className="sr-only"
                  onChange={(event) => {
                    onPickImage(event.target.files)
                    event.target.value = ''
                    close()
                  }}
                />
              </label>
            ) : null}
            {hasCommands ? (
              <Button
                variant="plain"
                type="button"
                onClick={() => {
                  close()
                  onCommands()
                }}
                className={row}
              >
                <SquareSlash
                  size={19}
                  aria-hidden
                  className="text-brand-muted"
                />
                {t`Commands`}
              </Button>
            ) : null}
            {onDeliveryPolicy ? (
              <SessionSendTimingRow
                value={deliveryPolicy}
                onOpen={() => setView('delivery')}
                className={row}
              />
            ) : null}
            {hasSkills ? (
              <Button
                variant="plain"
                type="button"
                data-testid="skills-chip"
                onClick={() => {
                  close()
                  onSkills()
                }}
                className={row}
              >
                <Sparkles size={19} aria-hidden className="text-brand-muted" />
                {t`Skills`}
              </Button>
            ) : null}
            {onSentHistory ? (
              <Button
                variant="plain"
                type="button"
                data-testid="sent-history-button"
                onClick={() => {
                  close()
                  onSentHistory()
                }}
                className={row}
              >
                <History size={19} aria-hidden className="text-brand-muted" />
                <span className="flex-1">{t`Sent messages`}</span>
                {unsettledCount > 0 ? (
                  <span className="rounded-full bg-brand-waiting/15 px-2 py-0.5 text-meta font-medium text-brand-waiting tabular-nums">
                    {unsettledCount}
                  </span>
                ) : null}
                <kbd className="hidden rounded border border-brand-border bg-brand-deck px-1.5 py-0.5 font-mono text-meta text-brand-label md:inline">
                  h
                </kbd>
              </Button>
            ) : null}
            {deferredCount > 0 && onOpenDeferred ? (
              <DeferredMenuItem
                count={deferredCount}
                className={row}
                onOpen={() => {
                  close()
                  onOpenDeferred()
                }}
              />
            ) : null}
            {hasDraft ? (
              <Button
                variant="plain"
                type="button"
                data-testid="composer-clear"
                onClick={() => {
                  close()
                  onClear()
                }}
                className={row}
              >
                <Trash2 size={19} aria-hidden className="text-brand-muted" />
                {t`Clear input`}
              </Button>
            ) : null}
          </div>
        )}
      </Sheet>
    </>
  )
}
