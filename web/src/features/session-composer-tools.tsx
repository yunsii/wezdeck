import { useLingui } from '@lingui/react/macro'
import {
  History,
  ImagePlus,
  Plus,
  Send,
  Timer,
  UserRoundCheck,
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
  deliveryPolicy?: 'immediate' | 'after_turn' | 'after_review'
  onDeliveryPolicy?: (
    policy: 'immediate' | 'after_turn' | 'after_review',
  ) => void
}) {
  const { t } = useLingui()
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)
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
        onOpenChange={setOpen}
        title={t`Message actions`}
        testId="composer-tools"
        write
      >
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
              <SquareSlash size={19} aria-hidden className="text-brand-muted" />
              {t`Commands`}
            </Button>
          ) : null}
          {onDeliveryPolicy ? (
            <div
              className={`${row} grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1`}
            >
              {deliveryPolicy === 'immediate' ? (
                <Send size={19} aria-hidden className="text-brand-muted" />
              ) : deliveryPolicy === 'after_turn' ? (
                <Timer size={19} aria-hidden className="text-brand-waiting" />
              ) : (
                <UserRoundCheck
                  size={19}
                  aria-hidden
                  className="text-brand-running"
                />
              )}
              <span>{t`Send timing`}</span>
              <div className="col-start-2 grid gap-1 text-meta text-brand-muted">
                {(
                  [
                    ['immediate', t`Send now`],
                    ['after_turn', t`Send when this turn ends`],
                    ['after_review', t`Wait for my confirmation`],
                  ] as const
                ).map(([policy, label]) => (
                  <Button
                    key={policy}
                    variant="plain"
                    type="button"
                    aria-pressed={deliveryPolicy === policy}
                    onClick={() => onDeliveryPolicy(policy)}
                    className="min-h-8 justify-start px-0 text-left text-meta"
                  >
                    <span
                      className={
                        deliveryPolicy === policy
                          ? 'text-brand-text'
                          : undefined
                      }
                    >
                      {deliveryPolicy === policy ? '● ' : '○ '}
                      {label}
                    </span>
                  </Button>
                ))}
              </div>
            </div>
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
      </Sheet>
    </>
  )
}
