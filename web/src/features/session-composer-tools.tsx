import { useLingui } from '@lingui/react/macro'
import { ImagePlus, Plus, Sparkles, SquareSlash, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Sheet } from '#/components/ui/sheet'
import { trace } from '#/lib/client-trace'

const row =
  'flex min-h-12 w-full items-center gap-3 border-b border-brand-edge px-2 text-left text-body text-brand-text last:border-b-0'

export function ComposerTools({
  writable,
  canPickImage,
  hasCommands,
  hasSkills,
  hasDraft,
  onPickImage,
  onCommands,
  onSkills,
  onClear,
}: {
  writable: boolean
  canPickImage: boolean
  hasCommands: boolean
  hasSkills: boolean
  hasDraft: boolean
  onPickImage: (files: FileList | null) => void
  onCommands: () => void
  onSkills: () => void
  onClear: () => void
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
        className="absolute bottom-1.5 left-1.5 inline-flex size-10 items-center justify-center rounded-full text-brand-muted"
      >
        <Plus size={19} aria-hidden />
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
