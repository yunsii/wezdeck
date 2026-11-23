// The session composer: text, plus a one-line toolbar above it (quick keys,
// screenshots; thumbnails sit in the same row). Diagnostics are no longer a
// toggle here: the host pulls them when it needs them (lib/host-diag.ts);
// this page only registers its state for that snapshot. Attachments upload first (lib/upload.ts), then the message is
// sent naming them; the host appends their paths so the agent can open them.
import { useLingui } from '@lingui/react/macro'
import {
  Check,
  Copy,
  ImagePlus,
  Keyboard,
  ListTodo,
  SendHorizontal,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { setDiagnosticsPage } from '#/lib/client-trace'
import { shrinkImage, uploadBlob } from '#/lib/upload'
import { cn } from '#/lib/utils'
import { ImageViewer } from './image-viewer'
import { TodoPanel, useTodos } from './session-todos'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Textarea } from '#/components/ui/textarea'

const MAX_IMAGES = 5

type Picked = { key: string; file: File; url: string }

export type Outgoing = {
  text: string
  attachments: Array<string>
  /** shown on the queued bubble, e.g. "2 images" */
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
      <Button
        variant="plain"
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
      </Button>
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
  const [progress, setProgress] = useState('')
  const urls = useRef(images)
  const pageState = useRef(diagnostics)
  pageState.current = diagnostics
  useEffect(() => setDiagnosticsPage(() => pageState.current()), [])
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

  const ready = Boolean(text.trim() || images.length)
  const submit = async () => {
    if (!ready || progress) return
    const steps = images.length
    const attachments: Array<string> = []
    try {
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
    const note = count ? t`${count} images` : ''
    // clear right away, like a chat app: the message shows in the queue
    // above; if the host refuses it, the text comes back with the error
    const typed = text
    setText('')
    if (await onSend({ text: typed.trim(), attachments, note })) {
      images.forEach((image) => URL.revokeObjectURL(image.url))
      setImages([])
    } else {
      setText((current) => current || typed)
    }
  }
  return {
    id,
    text,
    setText,
    images,
    pick,
    remove,
    progress,
    ready,
    submit,
  }
}

type Composer = ReturnType<typeof useComposer>
type Panel = 'keys' | 'todos' | null

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
    <div
      data-write
      className="grid gap-1.5 rounded-[16px] bg-brand-surface p-2"
    >
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="text-[11.5px] text-brand-label">
          {disabled
            ? t`Turn on write access in Settings to send these keys`
            : t`Tap to send into the agent pane`}
        </span>
        <Button
          variant="plain"
          type="button"
          onClick={onClose}
          aria-label={t`Close keys`}
          className="inline-flex size-7 items-center justify-center rounded-full text-brand-muted"
        >
          <X size={14} aria-hidden />
        </Button>
      </div>
      <div
        role="group"
        aria-label={t`Quick keys`}
        data-testid="session-quick-keys"
        className="grid grid-cols-3 gap-1.5"
      >
        {keys.map(({ key, label, hint }) => (
          <Button
            variant="key"
            key={key}
            type="button"
            disabled={disabled}
            onClick={() => {
              onKey(key)
              onClose()
            }}
            className="grid h-12 place-content-center gap-0.5 rounded-[10px] px-1 disabled:opacity-40"
          >
            <span className="text-[14px] leading-none font-medium">
              {label}
            </span>
            <span className="text-[11px] leading-none text-brand-label">
              {hint}
            </span>
          </Button>
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
  panel,
  onPanel,
}: {
  composer: Composer
  writable: boolean
  panel: Panel
  onPanel: (panel: Panel) => void
}) {
  const { t } = useLingui()
  const [preview, setPreview] = useState<number | null>(null)
  const todos = useTodos(composer.id)
  const openTodos = (todos.data?.todos ?? []).filter(
    (todo) => !todo.done,
  ).length
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
      <Button
        variant="plain"
        type="button"
        aria-pressed={panel === 'keys'}
        aria-label={t`Quick keys`}
        title={t`Send Enter, Esc or Ctrl+C into the agent pane`}
        onClick={() => onPanel(panel === 'keys' ? null : 'keys')}
        className={chip(panel === 'keys')}
      >
        <Keyboard size={14} aria-hidden />
        {t`Keys`}
      </Button>
      <Button
        variant="plain"
        type="button"
        aria-pressed={panel === 'todos'}
        title={t`Follow-ups of this repo`}
        onClick={() => onPanel(panel === 'todos' ? null : 'todos')}
        className={chip(panel === 'todos')}
      >
        <ListTodo size={14} aria-hidden />
        {t`To-dos`}
        {openTodos ? (
          <span className="text-[11px] tabular-nums opacity-80">
            {openTodos}
          </span>
        ) : null}
      </Button>
      {writable && !full ? (
        <label
          className={cn(
            chip(false),
            'cursor-pointer focus-within:ring-2 focus-within:ring-brand-running',
          )}
        >
          <ImagePlus size={14} aria-hidden />
          {t`Images`}
          <Input
            variant="bare"
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
      {composer.images.map((image, i) => (
        <span key={image.key} className="relative size-8 shrink-0">
          <Button
            variant="plain"
            type="button"
            aria-label={t`Preview image`}
            onClick={() => setPreview(i)}
            className="block size-8"
          >
            <img
              src={image.url}
              alt=""
              className="size-8 rounded-[8px] object-cover"
            />
          </Button>
          <Button
            variant="solid"
            type="button"
            aria-label={t`Remove image`}
            onClick={() => composer.remove(image.key)}
            className="absolute -top-1 -right-1 inline-flex size-4 items-center justify-center rounded-full"
          >
            <X size={10} aria-hidden />
          </Button>
        </span>
      ))}
      {preview !== null && composer.images.length ? (
        <ImageViewer
          images={composer.images.map((image) => ({
            key: image.key,
            src: image.url,
          }))}
          index={Math.min(preview, composer.images.length - 1)}
          onIndex={setPreview}
          onClose={() => setPreview(null)}
        />
      ) : null}
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
  // one tool panel at a time, above the toolbar
  const [panel, setPanel] = useState<Panel>(null)
  return (
    <>
      {panel === 'keys' ? (
        <KeyPanel
          disabled={keysDisabled}
          onKey={onKey}
          onClose={() => setPanel(null)}
        />
      ) : null}
      {panel === 'todos' ? (
        <TodoPanel
          session={composer.id}
          writable={writable}
          onUse={(text) => {
            composer.setText((current) =>
              current.trim() ? `${current.trimEnd()}\n${text}` : text,
            )
            setPanel(null)
            document.getElementById('session-composer')?.focus()
          }}
          onClose={() => setPanel(null)}
        />
      ) : null}
      <Toolbar
        composer={composer}
        writable={writable}
        panel={panel}
        onPanel={setPanel}
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
        <Textarea
          variant="bare"
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
        <Button
          variant="solid"
          type="submit"
          aria-label={t`Send`}
          disabled={Boolean(composer.progress) || !composer.ready || blocked}
          className="inline-flex size-10 shrink-0 items-center justify-center rounded-full disabled:opacity-30"
        >
          <SendHorizontal size={18} aria-hidden />
        </Button>
      </div>
    </>
  )
}
