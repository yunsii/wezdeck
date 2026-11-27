// The session composer: wraps the shared MessageComposer primitive with
// session-specific slash commands, skill completion, diagnostics registration,
// and the ＋ tools sheet (images, commands, skills, sent history, clear).
import { useLingui } from '@lingui/react/macro'
import { Link } from '@tanstack/react-router'
import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '#/components/ui/button'
import { setDiagnosticsPage } from '#/lib/client-trace'
import { CommandPanel } from './session-commands'
import { useSkillCompletion } from './composer-complete'
import { useComposerSuggestions } from './composer-suggest-hook'
import { MAX_IMAGES } from './composer-images'
import { useSpaceToFocus } from './composer-keys'
import { MessageComposer, useRichDraft } from './message-composer'
import type { Outgoing } from './message-composer'
import { ComposerTools } from './session-composer-tools'

export type { Outgoing }

const draftKey = (id: string) => `wezdeck.draft.${id}`

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
  const draft = useRichDraft({
    storageKey: draftKey(id),
    imageKey: id,
    onSend,
    deferUpload: true,
  })
  const pageState = useRef(diagnostics)
  pageState.current = diagnostics
  useEffect(() => setDiagnosticsPage(() => pageState.current()), [])

  return {
    id,
    ...draft,
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
  onOpenSentHistory,
  onRecallLatest,
  unsettledCount = 0,
  commands,
  session,
}: {
  composer: Composer
  blocked: boolean
  /** false while a confirmation is pending so Enter / Esc / Ctrl+C still work */
  keysDisabled: boolean
  /** this device may write: only then are image / diagnostics attachments offered */
  writable: boolean
  onRun: (
    action: 'key' | 'session.restart',
    args: Record<string, unknown>,
  ) => Promise<boolean>
  onNewConversation: () => Promise<boolean>
  onOpenSentHistory?: () => void
  onRecallLatest?: () => void
  unsettledCount?: number
  /** Claude / Agy sessions: send a slash command, open 恢复会话 */
  commands?: { send: (text: string) => void; resume: () => void }
  /** the session reply: its agent and `skills_rev` drive the 能力 chip and `/` completion */
  session?: { agent?: string; skills_rev?: string }
}) {
  const { t } = useLingui()
  const [commandsOpen, setCommandsOpen] = useState(false)
  const complete = useSkillCompletion(composer, session)
  const suggest = useComposerSuggestions(composer, Boolean(complete.list))

  useSpaceToFocus()
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return
      if (
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        (event.key === 'F5' ||
          event.code === 'KeyR' ||
          event.key.toLowerCase() === 'r')
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
            composer.textareaRef.current?.focus()
          }}
          onClose={() => setCommandsOpen(false)}
        />
      ) : null}
      {complete.sheet}
      <MessageComposer
        draft={composer}
        inputId="session-composer"
        label={t`Message to the agent`}
        placeholder={t`Message`}
        writable={writable}
        blocked={blocked}
        topSlot={complete.list ?? suggest.list}
        inputProps={{
          ...complete.inputProps,
          role: complete.list || suggest.open ? 'combobox' : undefined,
          'aria-expanded': complete.list || suggest.open ? true : undefined,
          'aria-controls': complete.list
            ? 'composer-completions'
            : suggest.open
              ? 'composer-suggestions'
              : undefined,
          'aria-activedescendant': complete.list
            ? complete.inputProps['aria-activedescendant']
            : suggest.open && suggest.active >= 0
              ? `composer-suggestion-${suggest.active}`
              : undefined,
          onSelect: (event: React.SyntheticEvent<HTMLTextAreaElement>) => {
            complete.inputProps.onSelect(event)
            suggest.track(event.currentTarget.selectionStart)
          },
          onBlur: () => {
            complete.inputProps.onBlur()
            suggest.track(null)
          },
        }}
        onChangeTrack={(pos) => {
          complete.track(pos)
          suggest.track(pos)
        }}
        onExtraKeyDown={(event) => complete.key(event) || suggest.key(event)}
        onRecallLatest={onRecallLatest}
        leadingSlot={
          <ComposerTools
            writable={writable}
            canPickImage={composer.images.length < MAX_IMAGES}
            hasCommands={Boolean(commands)}
            hasSkills={complete.hasSkills}
            hasDraft={Boolean(composer.text || composer.images.length)}
            unsettledCount={unsettledCount}
            onPickImage={composer.pick}
            onCommands={() => setCommandsOpen(true)}
            onSkills={complete.openSkills}
            onSentHistory={onOpenSentHistory}
            onClear={() => composer.clear('menu')}
          />
        }
      />
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
