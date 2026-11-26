// The session composer: text, plus a one-line toolbar above it (quick keys,
// screenshots; thumbnails sit in the same row). Diagnostics are no longer a
// toggle here: the host pulls them when it needs them (lib/host-diag.ts);
// this page only registers its state for that snapshot. Attachments upload first (lib/upload.ts), then the message is
// sent naming them; the host appends their paths so the agent can open them.
import { useLingui } from '@lingui/react/macro'
import { restoreDraft, useDraft } from '#/lib/use-draft'
import {
  Check,
  Copy,
  ImagePlus,
  Keyboard,
  ListTodo,
  SendHorizontal,
  SquareSlash,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { toast } from 'sonner'
import { setDiagnosticsPage, trace } from '#/lib/client-trace'
import { useMediaQuery } from '#/lib/use-media'
import { shrinkImage, uploadBlob } from '#/lib/upload'
import { cn } from '#/lib/utils'
import { TodoPanel, useTodos } from './session-todos'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Textarea } from '#/components/ui/textarea'
import { CommandPanel } from './session-commands'
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
import { HandoffActions } from './session-handoff'
import { RestartActions } from './session-restart'
import { KeyPanel } from './session-key-panel'

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
type Panel = 'keys' | 'todos' | 'commands' | null

const tool =
  'inline-flex h-8 shrink-0 items-center gap-1 rounded-full px-2.5 text-caption'

/**
 * One row above the input: 快捷 (always), then 图片 and 诊断 once this phone
 * may write, then the picked thumbnails. What a tool opens — the key pad,
 * the diagnostics note — renders above the row in the same card style.
 */
function Toolbar({
  composer,
  writable,
  commands,
  panel,
  onPanel,
  skills,
}: {
  composer: Composer
  writable: boolean
  /** a Claude session: offer the 命令 panel */
  commands: boolean
  panel: Panel
  onPanel: (panel: Panel) => void
  /** the 能力 chip */
  skills: React.ReactNode
}) {
  const { t } = useLingui()
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
      {commands ? (
        <Button
          variant="plain"
          type="button"
          aria-pressed={panel === 'commands'}
          title={t`Slash commands for Claude`}
          onClick={() => onPanel(panel === 'commands' ? null : 'commands')}
          className={chip(panel === 'commands')}
        >
          <SquareSlash size={14} aria-hidden />
          {t`Commands`}
        </Button>
      ) : null}
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
          <span className="text-meta tabular-nums opacity-80">{openTodos}</span>
        ) : null}
      </Button>
      {skills}
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
    </div>
  )
}

export function ComposerBox({
  composer,
  blocked,
  keysDisabled,
  writable,
  onRun,
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
  /** Claude sessions: send a slash command, open 恢复会话 */
  commands?: { send: (text: string) => void; resume: () => void }
  /** the session reply: its agent and `skills_rev` drive the 能力 chip and `/` completion */
  session?: { agent?: string; skills_rev?: string }
}) {
  const { t } = useLingui()
  // one tool panel at a time, above the toolbar
  const [panel, setPanel] = useState<Panel>(null)
  const complete = useSkillCompletion(composer, session)
  // a touch keyboard has one Enter key and no Shift+Enter: there Enter is
  // a new line and the button sends (as in Telegram / WhatsApp); with a
  // mouse and keyboard Enter sends, Shift+Enter breaks the line
  const touch = useMediaQuery('(hover: none) and (pointer: coarse)', false)
  const canSend = !composer.progress && composer.ready && !blocked

  useSpaceToFocus()
  return (
    <>
      {panel === 'keys' ? (
        <KeyPanel
          disabled={keysDisabled}
          onKey={(key) => void onRun('key', { key })}
          onClose={() => setPanel(null)}
        >
          <RestartActions
            agent={session?.agent}
            disabled={keysDisabled}
            onRestart={(fresh) => onRun('session.restart', { fresh })}
            onDone={() => setPanel(null)}
          />
          <HandoffActions
            id={composer.id}
            agent={session?.agent}
            disabled={keysDisabled}
            onDone={() => setPanel(null)}
          />
        </KeyPanel>
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
      {panel === 'commands' && commands ? (
        <CommandPanel
          agent={session?.agent}
          disabled={keysDisabled}
          onCommand={commands.send}
          onResume={commands.resume}
          onDraft={(text) => {
            composer.setText(text)
            document.getElementById('session-composer')?.focus()
          }}
          onClose={() => setPanel(null)}
        />
      ) : null}
      {complete.list}
      <PickedImages composer={composer} />
      <Toolbar
        composer={composer}
        writable={writable}
        commands={Boolean(commands)}
        panel={panel}
        onPanel={setPanel}
        skills={complete.chip}
      />
      {complete.sheet}
      {composer.progress ? (
        <p role="status" className="px-1 text-meta text-brand-muted">
          {composer.progress}
        </p>
      ) : null}
      <div
        data-text-field
        className={cn(
          'relative rounded-3xl bg-brand-surface p-1.5',
          composer.text || composer.images.length ? 'min-h-16' : 'min-h-12',
        )}
      >
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
            if (complete.key(event)) return
            if (tokenKey(event, composer.setText)) return
            // Esc blurs (IM); clear stays on the × button with undo
            if (event.key === 'Escape') {
              event.preventDefault()
              event.currentTarget.blur()
              return
            }
            if (event.key !== 'Enter') return
            // the IME's Enter picks a candidate (拼音 → 汉字), it is not a send
            if (event.nativeEvent.isComposing || event.keyCode === 229) return
            if (event.shiftKey || event.altKey) return
            // Ctrl/⌘+Enter sends everywhere, plain Enter only off touch
            if (touch && !(event.ctrlKey || event.metaKey)) return
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
          enterKeyHint={touch ? 'enter' : 'send'}
          rows={1}
          placeholder={t`Message`}
          className={cn(
            'w-full max-h-40 min-h-10 min-w-0 resize-none bg-transparent px-3 py-2 pr-14 text-body outline-none [field-sizing:content] placeholder:text-brand-label',
            composer.text || composer.images.length ? 'pb-12' : null,
          )}
        />
        {composer.text || composer.images.length ? (
          <Button
            variant="plain"
            type="button"
            data-testid="composer-clear"
            aria-label={t`Clear input`}
            title={t`Clear input`}
            onClick={() => composer.clear('button')}
            className="absolute right-1.5 top-1.5 inline-flex size-10 items-center justify-center rounded-full text-brand-label"
          >
            <X size={18} aria-hidden />
          </Button>
        ) : null}
        <Button
          variant="solid"
          // round: no side padding — the default size's px-4 left 8 px of a
          // 40 px circle for the icon, which shrank to fit whatever size it had
          size="round"
          type="submit"
          aria-label={t`Send`}
          disabled={!canSend}
          className="absolute bottom-1.5 right-1.5 inline-flex size-10 items-center justify-center rounded-full disabled:opacity-30"
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
