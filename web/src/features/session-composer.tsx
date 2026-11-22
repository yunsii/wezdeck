// The session composer: text, plus an attach tray for reporting a problem
// from the phone — a "attach diagnostics" checkbox (lib/client-trace.ts) and
// screenshots. Attachments upload first (lib/upload.ts), then the message is
// sent naming them; the host appends their paths so the agent can open them.
import { useLingui } from '@lingui/react/macro'
import { ImagePlus, Paperclip, SendHorizontal, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { diagnosticsSnapshot } from '#/lib/client-trace'
import { shrinkImage, uploadBlob } from '#/lib/upload'
import { cn } from '#/lib/utils'

const MAX_IMAGES = 5

type Picked = { key: string; file: File; url: string }

export type Outgoing = {
  text: string
  attachments: Array<string>
  /** shown on the queued bubble, e.g. "2 images, diagnostics" */
  note: string
}

export function useComposer({
  onSend,
  diagnostics,
}: {
  onSend: (message: Outgoing) => Promise<boolean>
  /** page state merged into the diagnostics snapshot */
  diagnostics: () => Record<string, unknown>
}) {
  const { t } = useLingui()
  const [text, setText] = useState('')
  const [images, setImages] = useState<Array<Picked>>([])
  const [diag, setDiag] = useState(false)
  const [open, setOpen] = useState(false)
  const [progress, setProgress] = useState('')
  const urls = useRef(images)
  urls.current = images
  useEffect(
    () => () => urls.current.forEach((image) => URL.revokeObjectURL(image.url)),
    [],
  )

  const pick = (files: FileList | null) => {
    const room = MAX_IMAGES - images.length
    const added = [...(files ?? [])]
      .filter((file) => file.type.startsWith('image/'))
      .slice(0, room)
      .map((file) => ({
        key: crypto.randomUUID(),
        file,
        url: URL.createObjectURL(file),
      }))
    setImages((current) => [...current, ...added])
  }
  const remove = (key: string) => {
    setImages((current) => {
      const gone = current.find((image) => image.key === key)
      if (gone) URL.revokeObjectURL(gone.url)
      return current.filter((image) => image.key !== key)
    })
  }

  const ready = Boolean(text.trim() || images.length || diag)
  const submit = async () => {
    if (!ready || progress) return
    const steps = images.length + (diag ? 1 : 0)
    const attachments: Array<string> = []
    try {
      if (diag) {
        const step = attachments.length + 1
        setProgress(t`Uploading ${step}/${steps}…`)
        const json = JSON.stringify(diagnosticsSnapshot(diagnostics()))
        attachments.push(
          await uploadBlob(
            new Blob([json], { type: 'application/json' }),
            'application/json',
          ),
        )
      }
      for (const image of images) {
        const step = attachments.length + 1
        setProgress(t`Uploading ${step}/${steps}…`)
        const small = await shrinkImage(image.file)
        attachments.push(await uploadBlob(small, 'image/jpeg'))
      }
    } catch (error) {
      setProgress('')
      throw error
    }
    setProgress('')
    const count = images.length
    const note = [count ? t`${count} images` : '', diag ? t`diagnostics` : '']
      .filter(Boolean)
      .join(t`, `)
    if (await onSend({ text: text.trim(), attachments, note })) {
      setText('')
      images.forEach((image) => URL.revokeObjectURL(image.url))
      setImages([])
      setDiag(false)
      setOpen(false)
    }
  }
  return {
    text,
    setText,
    images,
    pick,
    remove,
    diag,
    setDiag,
    open,
    setOpen,
    progress,
    ready,
    submit,
  }
}

type Composer = ReturnType<typeof useComposer>

function AttachTray({ composer }: { composer: Composer }) {
  const { t } = useLingui()
  const full = composer.images.length >= MAX_IMAGES
  return (
    <div
      data-testid="attach-tray"
      className="grid gap-2.5 rounded-[16px] bg-brand-surface p-3"
    >
      <label className="flex items-start gap-2.5 text-[14px]">
        <input
          type="checkbox"
          checked={composer.diag}
          onChange={(event) => composer.setDiag(event.target.checked)}
          className="mt-0.5 size-[18px] accent-[var(--color-brand-running)]"
        />
        <span className="grid gap-0.5">
          <span>{t`Attach this phone's diagnostics`}</span>
          <span className="text-[12px] leading-snug text-brand-label">
            {t`Screen and keyboard sizes, scroll position, link mode, build, and the last 150 page events. No tokens, no message text.`}
          </span>
        </span>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        {composer.images.map((image) => (
          <div key={image.key} className="relative size-16">
            <img
              src={image.url}
              alt=""
              className="size-16 rounded-[10px] object-cover"
            />
            <button
              type="button"
              aria-label={t`Remove image`}
              onClick={() => composer.remove(image.key)}
              className="absolute -top-1.5 -right-1.5 inline-flex size-6 items-center justify-center rounded-full bg-brand-text text-brand-deck"
            >
              <X size={13} aria-hidden />
            </button>
          </div>
        ))}
        {full ? null : (
          <label className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-[12px] border border-dashed border-brand-edge px-3 text-[13px] text-brand-muted focus-within:ring-2 focus-within:ring-brand-running">
            <ImagePlus size={16} aria-hidden />
            {t`Add images`}
            <input
              type="file"
              accept="image/*"
              multiple
              className="sr-only"
              onChange={(event) => {
                composer.pick(event.target.files)
                event.target.value = ''
              }}
            />
          </label>
        )}
      </div>
    </div>
  )
}

export function ComposerBox({
  composer,
  blocked,
}: {
  composer: Composer
  blocked: boolean
}) {
  const { t } = useLingui()
  const attached = composer.images.length + (composer.diag ? 1 : 0)
  return (
    <>
      {composer.open ? <AttachTray composer={composer} /> : null}
      {composer.progress ? (
        <p role="status" className="px-1 text-xs text-brand-muted">
          {composer.progress}
        </p>
      ) : null}
      <div className="flex items-end gap-1.5 rounded-[22px] bg-brand-surface p-1.5">
        <button
          type="button"
          aria-label={t`Attachments`}
          aria-expanded={composer.open}
          onClick={() => composer.setOpen(!composer.open)}
          className={cn(
            'relative inline-flex size-10 shrink-0 items-center justify-center rounded-full text-brand-muted',
            composer.open && 'bg-brand-deck text-brand-text',
          )}
        >
          <Paperclip size={18} aria-hidden />
          {attached ? (
            <span className="absolute top-0.5 right-0.5 inline-flex min-w-4 items-center justify-center rounded-full bg-brand-running px-1 text-[10px] leading-4 font-medium text-brand-deck">
              {attached}
            </span>
          ) : null}
        </button>
        <label htmlFor="session-composer" className="sr-only">
          {t`Message to the agent`}
        </label>
        <textarea
          id="session-composer"
          value={composer.text}
          onFocus={(event) => {
            // keep the composer above the keyboard once it has opened
            const form = event.currentTarget.form
            setTimeout(() => form?.scrollIntoView({ block: 'end' }), 300)
          }}
          onChange={(event) => composer.setText(event.target.value)}
          rows={1}
          placeholder={t`Message`}
          className="max-h-40 min-h-10 min-w-0 flex-1 resize-none bg-transparent px-2 py-2 text-[16px] outline-none [field-sizing:content] placeholder:text-brand-label"
        />
        <button
          type="submit"
          aria-label={t`Send`}
          disabled={Boolean(composer.progress) || !composer.ready || blocked}
          className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-text text-brand-deck disabled:opacity-30"
        >
          <SendHorizontal size={18} aria-hidden />
        </button>
      </div>
    </>
  )
}
