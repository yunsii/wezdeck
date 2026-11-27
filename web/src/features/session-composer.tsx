// The session composer: text and a plus menu for attachments and commands.
// Diagnostics are no longer a
// toggle here: the host pulls them when it needs them (lib/host-diag.ts);
// this page only registers its state for that snapshot. Attachments upload first (lib/upload.ts), then the message is
// sent naming them; the host appends their paths so the agent can open them.
import { useLingui } from '@lingui/react/macro'
import { Link } from '@tanstack/react-router'
import { restoreDraft, useDraft } from '#/lib/use-draft'
import { Check, Copy, SendHorizontal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { toast } from 'sonner'
import { setDiagnosticsPage, trace } from '#/lib/client-trace'
import { useIsWide, useMediaQuery } from '#/lib/use-media'
import { shrinkImage, uploadBlob } from '#/lib/upload'
import { Button } from '#/components/ui/button'
import { Textarea } from '#/components/ui/textarea'
import { CommandPanel } from './session-commands'
import {
  isHardwareOnlyKey,
  isSoftKeyboardOpen,
  shouldEnterSend,
} from './composer-enter'
import { useSpaceToFocus } from './composer-keys'
import {
  MAX_IMAGES,
  forgetPicks,
  restorePicks,
  usePickedImages,
} from './composer-images'
import { PickedImages } from './composer-picked'
import { tokenKey } from './composer-tokens'
import { useSkillCompletion } from './composer-complete'
import { ComposerTools } from './session-composer-tools'

export type Outgoing = {
  text: string
  attachments: Array<string>
  /** shown on the queued bubble, e.g. "2 images" */
  note: string
}

const draftKey = (id: string) => `wezdeck.draft.${id}`

/**
 * Unsent text survives leaving the page (per session, this browser only).
 * Loaded on mount, written only when the text is changed: a write effect
 * keyed on the text ran in the mount pass with the still-empty state and
 * deleted the draft it was about to load (seen when the page mounted twice).
 */
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
    <p
      role="alert"
      className="flex items-start gap-2 text-meta text-brand-error"
    >
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
  const [text, setText] = useDraft(draftKey(id))
  const [progress, setProgress] = useState('')
  const { images, setImages, pick, remove, insertToken } = usePickedImages(
    id,
    text,
    setText,
  )
  const pageState = useRef(diagnostics)
  pageState.current = diagnostics
  useEffect(() => setDiagnosticsPage(() => pageState.current()), [])

  const ready = Boolean(text.trim() || images.length)
  const submit = async () => {
    if (!ready || progress) return
    // clear at once, like a chat app — text, images and their saved copies:
    // the page left and opened again while images were still uploading
    // used to load the stored draft back next to the sent message. A failed
    // upload or a refused send puts both back (into storage, so that works
    // with the page gone too, unless something new was typed meanwhile)
    const typed = text
    const picked = images
    setText('')
    setImages([])
    void forgetPicks(id)
    const giveBack = () => {
      restoreDraft(draftKey(id), typed)
      void restorePicks(
        id,
        picked.map(({ key, file }) => ({ key, file })),
      )
    }
    const steps = picked.length
    const attachments: Array<string> = []
    try {
      for (const image of picked) {
        const step = attachments.length + 1
        setProgress(t`Uploading ${step}/${steps}…`)
        const small = await shrinkImage(image.file)
        attachments.push(await uploadBlob(small, 'image/jpeg'))
      }
    } catch (error) {
      setProgress('')
      giveBack()
      throw error
    }
    setProgress('')
    const count = picked.length
    const note = count ? t`${count} images` : ''
    if (!(await onSend({ text: typed.trim(), attachments, note }))) giveBack()
    picked.forEach((image) => URL.revokeObjectURL(image.url))
  }
  /** empty the composer (×), with an undo */
  const clear = (via: string) => {
    const typed = text
    const picked = images
    if (!typed && !picked.length) return
    setText('')
    setImages([])
    void forgetPicks(id)
    trace('composer-clear', { via, chars: typed.length, images: picked.length })
    toast(t`Input cleared`, {
      action: {
        label: t`Undo`,
        onClick: () => {
          setText((current) => current || typed)
          setImages((current) => (current.length ? current : picked))
        },
      },
    })
  }
  return {
    id,
    text,
    setText,
    clear,
    images,
    pick,
    remove,
    insertToken,
    progress,
    ready,
    submit,
  }
}

export type Composer = ReturnType<typeof useComposer>

export function ComposerBox({
  composer,
  blocked,
  keysDisabled,
  writable,
  onRun,
  onNewConversation,
  commands,
  session,
}: {
  composer: Composer
  blocked: boolean
  /** false while a confirmation is pending so Enter / Esc / Ctrl+C still work */
  keysDisabled: boolean
  /** this phone may write: only then are image / diagnostics attachments offered */
  writable: boolean
  /** an allowlisted key into the agent pane (Enter / Esc / Ctrl+C / …), or
   * session.restart (重启会话 / 新开会话); true once the host took it */
  onRun: (
    action: 'key' | 'session.restart',
    args: Record<string, unknown>,
  ) => Promise<boolean>
  onNewConversation: () => Promise<boolean>
  /** Claude sessions: send a slash command, open 恢复会话 */
  commands?: { send: (text: string) => void; resume: () => void }
  /** the session reply: its agent and `skills_rev` drive the 能力 chip and `/` completion */
  session?: { agent?: string; skills_rev?: string }
}) {
  const { t } = useLingui()
  const [commandsOpen, setCommandsOpen] = useState(false)
  const complete = useSkillCompletion(composer, session)
  // Touch-only phones have no Shift+Enter so Enter breaks the line; desktops
  // and tablets with a hardware keyboard (with or without a trackpad) use
  // Enter to send and Shift+Enter for a newline.
  const coarsePrimary = useMediaQuery(
    '(hover: none) and (pointer: coarse)',
    false,
  )
  const anyFinePointer = useMediaQuery(
    '(any-pointer: fine), (any-hover: hover)',
    true,
  )
  const wide = useIsWide()
  const [sawHardwareKey, setSawHardwareKey] = useState(false)
  const touchOnly = coarsePrimary && !anyFinePointer && !sawHardwareKey
  const canSend = !composer.progress && composer.ready && !blocked

  useSpaceToFocus()
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return
      if (
        event.key === 'F5' &&
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey
      ) {
        if (
          keysDisabled ||
          document.querySelector('[role=dialog], [role=alertdialog]')
        )
          return
        event.preventDefault()
        void onRun('session.restart', { fresh: false })
        return
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return
      if (event.code !== 'KeyN') return
      event.preventDefault()
      if (event.shiftKey) void onRun('session.restart', { fresh: true })
      else void onNewConversation()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [keysDisabled, onNewConversation, onRun])
  return (
    <>
      {commands ? (
        <CommandPanel
          open={commandsOpen}
          agent={session?.agent}
          disabled={keysDisabled}
          onCommand={commands.send}
          onResume={commands.resume}
          onDraft={(text) => {
            composer.setText(text)
            document.getElementById('session-composer')?.focus()
          }}
          onClose={() => setCommandsOpen(false)}
        />
      ) : null}
      {complete.list}
      <PickedImages composer={composer} />
      {complete.sheet}
      {composer.progress ? (
        <p role="status" className="px-1 text-meta text-brand-muted">
          {composer.progress}
        </p>
      ) : null}
      <div
        data-text-field
        className="relative flex min-h-12 items-center rounded-3xl bg-brand-surface p-1"
      >
        <ComposerTools
          writable={writable}
          canPickImage={composer.images.length < MAX_IMAGES}
          hasCommands={Boolean(commands)}
          hasSkills={complete.hasSkills}
          hasDraft={Boolean(composer.text || composer.images.length)}
          onPickImage={composer.pick}
          onCommands={() => setCommandsOpen(true)}
          onSkills={complete.openSkills}
          onClear={() => composer.clear('menu')}
        />
        <label htmlFor="session-composer" className="sr-only">
          {t`Message to the agent`}
        </label>
        <Textarea
          variant="bare"
          id="session-composer"
          {...complete.inputProps}
          value={composer.text}
          onFocus={(event) => {
            // keep the composer above the keyboard once it has opened
            const form = event.currentTarget.form
            setTimeout(() => form?.scrollIntoView({ block: 'end' }), 300)
          }}
          onChange={(event) => {
            composer.setText(event.target.value)
            complete.track(event.target.selectionStart)
          }}
          onKeyDown={(event) => {
            if (!sawHardwareKey && isHardwareOnlyKey(event))
              setSawHardwareKey(true)
            if (complete.key(event)) return
            if (tokenKey(event, composer.setText)) return
            // Esc blurs (IM); clear stays on the × button with undo
            if (event.key === 'Escape') {
              event.preventDefault()
              event.currentTarget.blur()
              return
            }
            if (
              !shouldEnterSend({
                coarsePrimary,
                anyFinePointer,
                wide,
                sawHardwareKey: sawHardwareKey || isHardwareOnlyKey(event),
                softKeyboardOpen: isSoftKeyboardOpen(),
                key: event.key,
                code: event.code,
                shiftKey: event.shiftKey,
                altKey: event.altKey,
                ctrlKey: event.ctrlKey,
                metaKey: event.metaKey,
                isComposing: event.nativeEvent.isComposing,
                keyCode: event.keyCode,
              })
            )
              return
            event.preventDefault()
            if (canSend) event.currentTarget.form?.requestSubmit()
          }}
          onPaste={(event) => {
            // a screenshot on the clipboard joins the picked images; text
            // copied together with an image (a document) still pastes as text
            if (!writable) return
            const files = [...event.clipboardData.files].filter((file) =>
              file.type.startsWith('image/'),
            )
            if (files.length === 0) return
            // text pasted with the image lands first (the browser inserts
            // it after this handler), then the token goes after it
            if (event.clipboardData.types.includes('text/plain'))
              setTimeout(() => composer.pick(files))
            else {
              event.preventDefault()
              composer.pick(files)
            }
          }}
          enterKeyHint={touchOnly ? 'enter' : 'send'}
          rows={1}
          placeholder={t`Message`}
          className="w-full max-h-40 min-h-10 min-w-0 resize-none bg-transparent py-2 pl-11 pr-14 text-body outline-none [field-sizing:content] placeholder:text-brand-label"
        />
        <Button
          variant="solid"
          // round: no side padding — the default size's px-4 left 8 px of a
          // 40 px circle for the icon, which shrank to fit whatever size it had
          size="round"
          type="submit"
          aria-label={t`Send`}
          aria-keyshortcuts="Control+Enter Meta+Enter"
          title={`${t`Send`} · Ctrl/⌘+Enter`}
          disabled={!canSend}
          className="absolute right-1.5 top-1/2 inline-flex size-10 -translate-y-1/2 items-center justify-center rounded-full disabled:opacity-30"
        >
          <SendHorizontal
            size={20}
            strokeWidth={2.25}
            aria-hidden
            className="shrink-0"
          />
        </Button>
      </div>
    </>
  )
}

export function SessionComposerNotice({
  stale,
  staleAt,
  staleMessage,
  retryIn,
  error,
  blocked,
  readOnly,
  approved,
  locale,
}: {
  stale: boolean
  staleAt: string
  staleMessage?: string
  retryIn: number
  error: string
  blocked: string
  readOnly: boolean
  approved: boolean
  locale: 'en' | 'zh'
}) {
  const { t } = useLingui()
  return (
    <>
      {stale ? (
        <p
          role="status"
          data-testid="session-stale"
          className="rounded-xl bg-brand-waiting/10 px-3 py-1.5 text-meta text-brand-text"
        >
          {t`Can't get the latest from the host, showing ${staleAt}:`}{' '}
          {staleMessage ?? t`this device is offline`}
        </p>
      ) : null}
      {retryIn && !readOnly ? (
        <p role="status" className="text-meta text-brand-muted">
          {t`Someone just used the desk; sending in ${retryIn}s…`}
        </p>
      ) : error ? (
        <ErrorLine message={error} />
      ) : blocked && !readOnly ? (
        <p className="text-meta text-brand-muted">
          {blocked}{' '}
          {!approved ? (
            <Link
              to="/{-$locale}/console/me/$page"
              params={{
                locale: locale === 'en' ? undefined : locale,
                page: 'writing',
              }}
              className="text-brand-running"
            >
              {t`Open settings`}
            </Link>
          ) : null}
        </p>
      ) : null}
    </>
  )
}
