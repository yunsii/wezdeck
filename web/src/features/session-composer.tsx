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
  Keyboard,
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
    // clear right away, like a chat app: the message shows in the queue
    // above; if the host refuses it, the text comes back with the error
    const typed = text
    setText('')
    if (await onSend({ text: typed.trim(), attachments, note })) {
      images.forEach((image) => URL.revokeObjectURL(image.url))
      setImages([])
      setDiag(false)
    } else {
      setText((current) => current || typed)
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
 * The three keys any agent TUI understands. Choices (digits, arrows, Tab)
 * are not here: questions and plans get their own tap targets on the page
 * (session-elicitation.tsx, permission keys), which is where they belong.
 */
function useQuickKeys() {
  const { t } = useLingui()
  return [
    { key: 'Enter', label: 'Enter', hint: t`confirm` },
    { key: 'Escape', label: 'Esc', hint: t`cancel` },
    { key: 'C-c', label: 'Ctrl+C', hint: t`interrupt` },
  ] as const
}

/**
 * Confirm / cancel / interrupt for the session TUI (Ctrl+C stops Grok).
 * Opens above the toolbar like every tool; each key says what it does,
 * and the panel closes once a key is sent.
 */
function KeyPanel({
  disabled,
  onKey,
  onClose,
}: {
  disabled: boolean
  onKey: (key: string) => void
  onClose: () => void
}) {
  const { t } = useLingui()
  const keys = useQuickKeys()
  return (
    <div className="grid gap-1.5 rounded-[16px] bg-brand-surface p-2">
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="text-[11.5px] text-brand-label">
          {disabled
            ? t`Enable phone writing in Settings to send these keys`
            : t`Tap to send into the agent pane`}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t`Close keys`}
          className="inline-flex size-7 items-center justify-center rounded-full text-brand-muted"
        >
          <X size={14} aria-hidden />
        </button>
      </div>
      <div
        role="group"
        aria-label={t`Quick keys`}
        data-testid="session-quick-keys"
        className="grid grid-cols-3 gap-1.5"
      >
        {keys.map(({ key, label, hint }) => (
          <button
            key={key}
            type="button"
            disabled={disabled}
            onClick={() => {
              onKey(key)
              onClose()
            }}
            className="key-press grid h-12 place-content-center gap-0.5 rounded-[10px] border border-brand-edge bg-brand-deck px-1 disabled:opacity-40"
          >
            <span className="text-[14px] leading-none font-medium">
              {label}
            </span>
            <span className="text-[11px] leading-none text-brand-label">
              {hint}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * One row above the input: 快捷 (always), then 图片 and 诊断 once this phone
 * may write, then the picked thumbnails. What a tool opens — the key pad,
 * the diagnostics note — renders above the row in the same card style.
 */
function Toolbar({
  composer,
  writable,
  keysOpen,
  onKeys,
}: {
  composer: Composer
  writable: boolean
  keysOpen: boolean
  onKeys: () => void
}) {
  const { t } = useLingui()
  const full = composer.images.length >= MAX_IMAGES
  const chip = (on: boolean) =>
    cn(
      tool,
      on
        ? 'bg-brand-text text-brand-deck'
        : 'bg-brand-surface text-brand-muted',
    )
  return (
    <div
      role="toolbar"
      aria-label={t`Composer tools`}
      data-testid="composer-tools"
      className="flex items-center gap-1.5 overflow-x-auto px-0.5 py-1 [scrollbar-width:none]"
    >
      <button
        type="button"
        aria-pressed={keysOpen}
        aria-label={t`Quick keys`}
        title={t`Send Enter, Esc or Ctrl+C into the agent pane`}
        onClick={onKeys}
        className={chip(keysOpen)}
      >
        <Keyboard size={14} aria-hidden />
        {t`Keys`}
      </button>
      {writable && !full ? (
        <label
          className={cn(
            chip(false),
            'cursor-pointer focus-within:ring-2 focus-within:ring-brand-running',
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
      ) : null}
      {writable ? (
        <button
          type="button"
          aria-pressed={composer.diag}
          title={t`Screen and keyboard sizes, scroll position, link mode, build, and the last 150 page events. No tokens, no message text.`}
          onClick={() => composer.setDiag(!composer.diag)}
          className={chip(composer.diag)}
        >
          <Activity size={14} aria-hidden />
          {t`Diagnostics`}
        </button>
      ) : null}
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
  )
}

export function ComposerBox({
  composer,
  blocked,
  keysDisabled,
  writable,
  onKey,
}: {
  composer: Composer
  blocked: boolean
  /** false while a confirmation is pending so Enter / Esc / Ctrl+C still work */
  keysDisabled: boolean
  /** this phone may write: only then are image / diagnostics attachments offered */
  writable: boolean
  /** send an allowlisted key into the agent pane (Enter / Esc / Ctrl+C / …) */
  onKey: (key: string) => void
}) {
  const { t } = useLingui()
  const [keysOpen, setKeysOpen] = useState(false)
  return (
    <>
      {keysOpen ? (
        <KeyPanel
          disabled={keysDisabled}
          onKey={onKey}
          onClose={() => setKeysOpen(false)}
        />
      ) : null}
      {composer.diag ? (
        <p className="rounded-[12px] bg-brand-surface px-3 py-2 text-[11.5px] leading-snug text-brand-label">
          {t`Sends sizes, scroll state and recent page events; no tokens, no message text.`}
        </p>
      ) : null}
      <Toolbar
        composer={composer}
        writable={writable}
        keysOpen={keysOpen}
        onKeys={() => setKeysOpen(!keysOpen)}
      />
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
