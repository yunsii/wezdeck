// The session composer: text, plus a one-line toolbar above it for reporting
// a problem from the phone — add screenshots, toggle "attach diagnostics"
// (lib/client-trace.ts); thumbnails sit in the same row. Attachments upload first (lib/upload.ts), then the message is
// sent naming them; the host appends their paths so the agent can open them.
import { useLingui } from '@lingui/react/macro'
import {
  Activity,
  Check,
  Copy,
  ImagePlus,
  SendHorizontal,
  X,
} from 'lucide-react'
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

const draftKey = (id: string) => `wezdeck.draft.${id}`

/** Unsent text survives leaving the page (per session, this browser only). */
function useDraft(id: string) {
  const [text, setText] = useState('')
  const loaded = useRef(false)
  useEffect(() => {
    try {
      const saved = localStorage.getItem(draftKey(id))
      if (saved) setText(saved)
    } catch {
      // storage blocked: drafts just don't persist
    }
    loaded.current = true
  }, [id])
  useEffect(() => {
    if (!loaded.current) return
    try {
      if (text) localStorage.setItem(draftKey(id), text)
      else localStorage.removeItem(draftKey(id))
    } catch {
      // storage blocked or full
    }
  }, [id, text])
  return [text, setText] as const
}

/** An error line with a one-tap copy, for pasting it elsewhere. */
export function ErrorLine({ message }: { message: string }) {
  const { t } = useLingui()
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message)
      setCopied(true)
      setTimeout(() => setCopied(false), 1_500)
    } catch {
      setCopied(false)
    }
  }
  return (
    <p role="alert" className="flex items-start gap-2 text-xs text-brand-error">
      <span className="min-w-0 flex-1 break-words select-text">{message}</span>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={t`Copy error`}
        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-brand-surface px-2 py-0.5 text-brand-muted"
      >
        {copied ? (
          <Check size={12} aria-hidden />
        ) : (
          <Copy size={12} aria-hidden />
        )}
        {copied ? t`Copied` : t`Copy`}
      </button>
    </p>
  )
}

export function useComposer({
  id,
  onSend,
  diagnostics,
}: {
  /** session id: the unsent draft is kept per session */
  id: string
  onSend: (message: Outgoing) => Promise<boolean>
  /** page state merged into the diagnostics snapshot */
  diagnostics: () => Record<string, unknown>
}) {
  const { t } = useLingui()
  const [text, setText] = useDraft(id)
  const [images, setImages] = useState<Array<Picked>>([])
  const [diag, setDiag] = useState(false)
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
    progress,
    ready,
    submit,
  }
}

type Composer = ReturnType<typeof useComposer>

const tool =
  'inline-flex h-8 shrink-0 items-center gap-1 rounded-full px-2.5 text-[12.5px]'

/**
 * Above the input: add images, toggle diagnostics, then the picked
 * thumbnails. What a tool opens renders above the row, away from the input.
 */
function Toolbar({ composer }: { composer: Composer }) {
  const { t } = useLingui()
  const full = composer.images.length >= MAX_IMAGES
  return (
    <div className="grid gap-1">
      {composer.diag ? (
        <p className="px-1 text-[11.5px] leading-snug text-brand-label">
          {t`Sends sizes, scroll state and recent page events; no tokens, no message text.`}
        </p>
      ) : null}
      <div
        role="toolbar"
        aria-label={t`Attachments`}
        data-testid="composer-tools"
        className="flex items-center gap-1.5 overflow-x-auto px-0.5 py-1 [scrollbar-width:none]"
      >
        {full ? null : (
          <label
            className={cn(
              tool,
              'cursor-pointer bg-brand-surface text-brand-muted focus-within:ring-2 focus-within:ring-brand-running',
            )}
          >
            <ImagePlus size={14} aria-hidden />
            {t`Images`}
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
        <button
          type="button"
          aria-pressed={composer.diag}
          title={t`Screen and keyboard sizes, scroll position, link mode, build, and the last 150 page events. No tokens, no message text.`}
          onClick={() => composer.setDiag(!composer.diag)}
          className={cn(
            tool,
            composer.diag
              ? 'bg-brand-text text-brand-deck'
              : 'bg-brand-surface text-brand-muted',
          )}
        >
          <Activity size={14} aria-hidden />
          {t`Diagnostics`}
        </button>
        {composer.images.map((image) => (
          <span key={image.key} className="relative size-8 shrink-0">
            <img
              src={image.url}
              alt=""
              className="size-8 rounded-[8px] object-cover"
            />
            <button
              type="button"
              aria-label={t`Remove image`}
              onClick={() => composer.remove(image.key)}
              className="absolute -top-1 -right-1 inline-flex size-4 items-center justify-center rounded-full bg-brand-text text-brand-deck"
            >
              <X size={10} aria-hidden />
            </button>
          </span>
        ))}
      </div>
    </div>
  )
}

export function ComposerBox({
  composer,
  blocked,
  writable,
}: {
  composer: Composer
  blocked: boolean
  /** this phone may write: only then are attachments offered */
  writable: boolean
}) {
  const { t } = useLingui()
  return (
    <>
      {writable ? <Toolbar composer={composer} /> : null}
      {composer.progress ? (
        <p role="status" className="px-1 text-xs text-brand-muted">
          {composer.progress}
        </p>
      ) : null}
      <div className="flex items-end gap-2 rounded-[22px] bg-brand-surface p-1.5">
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
          className="max-h-40 min-h-10 min-w-0 flex-1 resize-none bg-transparent px-3 py-2 text-[16px] outline-none [field-sizing:content] placeholder:text-brand-label"
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
