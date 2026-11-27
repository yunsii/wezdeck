// Shared AI-assisted Quick Ticket composer & sheet:
//   - Defaults target repo (`to`) to the current session's repo when available,
//     with 1-tap switching to any other configured target repo.
//   - Reuses `<MessageComposer>` (`useRichDraft`) so multi-line text, clipboard
//     paste images, [图片N] tokens, and already-uploaded screenshots (0 re-upload)
//     work identically across session chat, sent history, and ticket creation.
//   - Default submit (run=false): 0-wait instant create + async host AI enrich.
//   - Checking `run` or clicking "AI preview": runs synchronous `ticket.draft`
//     for editable review before creating (and optionally launching headless run).
import { useLingui } from '@lingui/react/macro'
import { ImagePlus, Loader2, Sparkles } from 'lucide-react'
import { useId } from 'react'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import { Checkbox } from '#/components/ui/checkbox'
import { Input } from '#/components/ui/input'
import { Select } from '#/components/ui/select'
import { Sheet } from '#/components/ui/sheet'
import { MAX_IMAGES } from './composer-images'
import type { MessagePayload } from './composer-images'
import { MessageComposer } from './message-composer'
import type { RichDraft } from './message-composer'
import { useQuickTicketController, useTicketTargets } from './ticket-quick-api'
import type {
  TicketCreatedInfo,
  TicketTarget,
  TicketTargetsReply,
} from './ticket-quick-api'
import { AiDraftPreview, ManualTicketFields } from './ticket-quick-manual'

export { useTicketTargets }
export type { TicketCreatedInfo, TicketTarget, TicketTargetsReply }

function QuickCaptureBody({
  draft,
  inputId,
  toKey,
  sessionId,
  compact,
  includeContext,
  run,
  busy,
  drafting,
  error,
  onIncludeContextChange,
  onRunChange,
  onPreview,
  onSubmitError,
}: {
  draft: RichDraft
  inputId: string
  toKey: string
  sessionId?: string
  compact: boolean
  includeContext: boolean
  run: boolean
  busy: boolean
  drafting: boolean
  error: string
  onIncludeContextChange: (next: boolean) => void
  onRunChange: (next: boolean) => void
  onPreview: () => void
  onSubmitError: (message: string) => void
}) {
  const { t } = useLingui()
  return (
    <>
      <MessageComposer
        draft={draft}
        inputId={inputId}
        label={t`Quick ticket description`}
        placeholder={
          compact
            ? t`Describe the issue or paste screenshots (AI structures in background)…`
            : t`Describe what you saw, paste screenshots, or drop notes — AI will structure it into a ticket…`
        }
        submitLabel={run ? t`AI preview & run` : t`Create ticket`}
        writable={!busy && !drafting}
        blocked={busy || drafting || !toKey}
        onSubmitForm={() => {
          draft
            .submit()
            .catch((e: unknown) => onSubmitError((e as Error).message))
        }}
        leadingSlot={
          draft.images.length < MAX_IMAGES ? (
            <label
              title={t`Attach images`}
              aria-label={t`Attach images`}
              className="absolute bottom-1.5 left-1.5 inline-flex size-10 cursor-pointer items-center justify-center rounded-full text-brand-muted hover:text-brand-text"
            >
              <ImagePlus size={19} aria-hidden />
              <Input
                variant="bare"
                type="file"
                accept="image/*"
                multiple
                disabled={busy || drafting}
                className="sr-only"
                onChange={(event) => {
                  draft.pick(event.target.files)
                  event.target.value = ''
                }}
              />
            </label>
          ) : undefined
        }
      />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-1 text-meta text-brand-muted">
        {sessionId ? (
          <label className="inline-flex min-h-7 items-center gap-1.5">
            <Checkbox
              checked={includeContext}
              disabled={busy || drafting}
              onCheckedChange={onIncludeContextChange}
            />
            {t`Include session context`}
          </label>
        ) : null}
        <label className="inline-flex min-h-7 items-center gap-1.5">
          <Checkbox
            checked={run}
            disabled={busy || drafting}
            onCheckedChange={onRunChange}
          />
          {t`Run now`}
        </label>
        <Button
          variant="link"
          size="none"
          type="button"
          disabled={!draft.ready || !toKey || busy || drafting}
          onClick={onPreview}
          className="ml-auto inline-flex items-center gap-1 text-meta text-brand-running disabled:opacity-40"
        >
          {drafting ? (
            <Loader2 size={13} aria-hidden className="animate-spin" />
          ) : (
            <Sparkles size={13} aria-hidden />
          )}
          {drafting ? t`Structuring…` : t`AI preview`}
        </Button>
      </div>

      {error ? (
        <p role="alert" className="px-1 text-meta text-brand-error">
          {error}
        </p>
      ) : null}
    </>
  )
}

export function QuickTicketForm({
  sessionId,
  defaultTo,
  initialPayload,
  draftKey = 'quick-ticket',
  compact = false,
  showManualToggle = true,
  onCreated,
}: {
  sessionId?: string
  defaultTo?: string
  initialPayload?: MessagePayload
  draftKey?: string
  compact?: boolean
  showManualToggle?: boolean
  onCreated?: (info: TicketCreatedInfo) => void
}) {
  const { t } = useLingui()
  const inputId = useId()
  const {
    targets,
    keys,
    mode,
    setMode,
    toKey,
    onToSelect,
    fromKey,
    setFromKey,
    includeContext,
    setIncludeContext,
    run,
    setRun,
    withManager,
    setWithManager,
    busy,
    drafting,
    error,
    setError,
    preview,
    setPreview,
    manualTitle,
    setManualTitle,
    manualObserved,
    setManualObserved,
    manualAssumed,
    setManualAssumed,
    draft,
    triggerManualPreview,
    submitStructured,
  } = useQuickTicketController({
    sessionId,
    defaultTo,
    initialPayload,
    draftKey,
    onCreated,
  })

  if (preview) {
    return (
      <AiDraftPreview
        draft={preview}
        toKey={toKey}
        run={run}
        withManager={withManager}
        busy={busy}
        error={error}
        onChange={(patch) =>
          setPreview((cur) => (cur ? { ...cur, ...patch } : cur))
        }
        onSwitchTarget={(next) => {
          onToSelect(next)
          setPreview((cur) => (cur ? { ...cur, suggestedTo: '' } : cur))
        }}
        onRunChange={setRun}
        onManagerChange={setWithManager}
        onBack={() => {
          draft.replacePayload({
            text: preview.originalText,
            attachments: preview.attachments,
          })
          setPreview(null)
        }}
        onConfirm={() =>
          void submitStructured(
            {
              mode: 'manual',
              from: targets.data?.session_target || 'web',
              to: toKey,
              title: preview.title.trim(),
              summary: preview.summary.trim() || preview.title.trim(),
              observed: preview.observed.trim(),
              assumed: preview.assumed.trim(),
              text: preview.originalText,
              attachments: preview.attachments,
              origin_session: sessionId || undefined,
              run,
            },
            { mode: 'preview', attachmentsCount: preview.attachments.length },
          )
        }
      />
    )
  }

  return (
    <div className="grid min-w-0 gap-2.5" data-testid="quick-ticket-form">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex min-w-0 items-center gap-1.5 text-caption text-brand-muted">
          <span className="shrink-0">{t`To`}</span>
          <Select
            size="sm"
            value={toKey}
            disabled={busy || drafting || keys.length === 0}
            onValueChange={onToSelect}
            options={keys.map((key) => ({ value: key, label: key }))}
            className="min-w-32"
          />
        </label>
        {showManualToggle ? (
          <Button
            variant="link"
            size="none"
            type="button"
            disabled={busy || drafting}
            onClick={() => setMode((m) => (m === 'quick' ? 'manual' : 'quick'))}
            className="text-meta text-brand-muted"
          >
            {mode === 'quick' ? t`Manual fields` : t`Quick AI capture`}
          </Button>
        ) : null}
      </div>

      {keys.length === 0 && !targets.isPending ? (
        <p className="text-meta text-brand-muted">
          {t`No target repositories configured in ~/.agent/tickets/config.yml.`}
        </p>
      ) : null}

      {mode === 'manual' ? (
        <ManualTicketFields
          keys={keys}
          fromKey={fromKey}
          toKey={toKey}
          title={manualTitle}
          observed={manualObserved}
          assumed={manualAssumed}
          run={run}
          withManager={withManager}
          busy={busy}
          error={error}
          onFromChange={setFromKey}
          onToChange={onToSelect}
          onTitleChange={setManualTitle}
          onObservedChange={setManualObserved}
          onAssumedChange={setManualAssumed}
          onRunChange={setRun}
          onManagerChange={setWithManager}
          onSubmit={() =>
            void submitStructured(
              {
                mode: 'manual',
                from: fromKey || 'web',
                to: toKey,
                title: manualTitle.trim(),
                observed: manualObserved.trim(),
                assumed: manualAssumed.trim(),
                origin_session: sessionId || undefined,
                run,
              },
              { mode: 'manual', attachmentsCount: 0 },
            )
          }
        />
      ) : (
        <QuickCaptureBody
          draft={draft}
          inputId={inputId}
          toKey={toKey}
          sessionId={sessionId}
          compact={compact}
          includeContext={includeContext}
          run={run}
          busy={busy}
          drafting={drafting}
          error={error}
          onIncludeContextChange={setIncludeContext}
          onRunChange={setRun}
          onPreview={() => void triggerManualPreview()}
          onSubmitError={setError}
        />
      )}
    </div>
  )
}

export function QuickTicketSheet({
  open,
  onOpenChange,
  title,
  testId = 'quick-ticket-sheet',
  sessionId,
  defaultTo,
  initialPayload,
  draftKey,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title?: string
  testId?: string
  sessionId?: string
  defaultTo?: string
  initialPayload?: MessagePayload
  draftKey?: string
  onCreated?: (info: TicketCreatedInfo) => void
}) {
  const { t } = useLingui()
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={title ?? t`New ticket`}
      testId={testId}
      write
    >
      <div className="px-4 pb-2">
        <QuickTicketForm
          sessionId={sessionId}
          defaultTo={defaultTo}
          initialPayload={initialPayload}
          draftKey={draftKey}
          onCreated={(info) => {
            onOpenChange(false)
            if (info.enriching) {
              toast(t`Ticket created (AI structuring in background)`)
            } else {
              toast(t`Ticket created`)
            }
            onCreated?.(info)
          }}
        />
      </div>
    </Sheet>
  )
}
