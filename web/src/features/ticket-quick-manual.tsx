// Manual ticket fields and editable AI-draft preview shared by QuickTicketForm.
import { useLingui } from '@lingui/react/macro'
import { ArrowLeft, Sparkles } from 'lucide-react'

import { Button } from '#/components/ui/button'
import { Checkbox } from '#/components/ui/checkbox'
import { Input } from '#/components/ui/input'
import { Select } from '#/components/ui/select'
import { Textarea } from '#/components/ui/textarea'
import { MessagePayloadView } from './chat-attachments'

export type TicketDraftPreviewData = {
  title: string
  summary: string
  observed: string
  assumed: string
  suggestedTo: string
  provider: string
  originalText: string
  attachments: Array<string>
}

export function AiDraftPreview({
  draft,
  toKey,
  run,
  withManager,
  busy,
  error,
  onChange,
  onSwitchTarget,
  onRunChange,
  onManagerChange,
  onBack,
  onConfirm,
}: {
  draft: TicketDraftPreviewData
  toKey: string
  run: boolean
  withManager: boolean
  busy: boolean
  error: string
  onChange: (patch: Partial<TicketDraftPreviewData>) => void
  onSwitchTarget: (nextTo: string) => void
  onRunChange: (next: boolean) => void
  onManagerChange: (next: boolean) => void
  onBack: () => void
  onConfirm: () => void
}) {
  const { t } = useLingui()
  const provider = draft.provider
  const suggested = draft.suggestedTo
  const ready =
    Boolean(toKey) &&
    Boolean(draft.title.trim()) &&
    Boolean(draft.observed.trim()) &&
    Boolean(draft.assumed.trim())
  return (
    <div className="grid min-w-0 gap-3" data-testid="ticket-draft-preview">
      <div className="flex items-center justify-between gap-2 text-meta text-brand-muted">
        <Button
          variant="plain"
          size="none"
          type="button"
          disabled={busy}
          onClick={onBack}
          className="inline-flex items-center gap-1 text-caption text-brand-text"
        >
          <ArrowLeft size={14} aria-hidden />
          {t`Back to edit`}
        </Button>
        <span className="inline-flex items-center gap-1 text-brand-label">
          <Sparkles size={13} aria-hidden />
          {provider ? t`Structured by ${provider}` : t`AI draft preview`}
        </span>
      </div>

      {suggested && suggested !== toKey ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-brand-waiting/10 px-3 py-2 text-meta text-brand-text">
          <span>
            {t`AI suggests filing this to ${suggested} instead of ${toKey}.`}
          </span>
          <Button
            variant="outline"
            size="sm"
            type="button"
            disabled={busy}
            onClick={() => onSwitchTarget(suggested)}
            className="rounded-full text-meta"
          >
            {t`Switch to ${suggested}`}
          </Button>
        </div>
      ) : null}

      <label className="grid gap-1 text-caption text-brand-muted">
        {t`Title`}
        <Input
          variant="field"
          value={draft.title}
          disabled={busy}
          maxLength={120}
          onChange={(event) => onChange({ title: event.target.value })}
        />
      </label>

      <label className="grid gap-1 text-caption text-brand-muted">
        {t`What you saw`}
        <Textarea
          value={draft.observed}
          disabled={busy}
          rows={3}
          onChange={(event) => onChange({ observed: event.target.value })}
        />
      </label>

      <label className="grid gap-1 text-caption text-brand-muted">
        {t`What you assume`}
        <Textarea
          value={draft.assumed}
          disabled={busy}
          rows={3}
          onChange={(event) => onChange({ assumed: event.target.value })}
        />
      </label>

      {draft.attachments.length > 0 ? (
        <div className="grid gap-1 rounded-xl bg-brand-surface p-2.5 text-meta text-brand-muted">
          <span>{t`Attached screenshots (kept with ticket)`}</span>
          <MessagePayloadView
            text=""
            attachments={draft.attachments}
            tone="surface"
          />
        </div>
      ) : null}

      <div className="grid gap-1">
        <label className="flex min-h-9 items-center gap-2 text-caption text-brand-text">
          <Checkbox
            checked={run}
            disabled={busy}
            onCheckedChange={onRunChange}
          />
          {t`Start working on it now (a headless run on the host)`}
        </label>
        <label className="flex min-h-9 items-center gap-2 text-caption text-brand-text">
          <Checkbox
            checked={withManager}
            disabled={busy}
            onCheckedChange={onManagerChange}
          />
          {t`Open a repo-neutral Manager Session for this ticket`}
        </label>
      </div>

      {error ? (
        <p role="alert" className="text-caption text-brand-error">
          {error}
        </p>
      ) : null}

      <Button
        variant="solid"
        type="button"
        disabled={!ready || busy}
        onClick={onConfirm}
        className="min-h-11 px-3 text-body disabled:opacity-40"
      >
        {busy
          ? t`Creating…`
          : run
            ? t`Create & start headless run`
            : t`Confirm & create ticket`}
      </Button>
    </div>
  )
}

export function ManualTicketFields({
  keys,
  fromKey,
  toKey,
  title,
  observed,
  assumed,
  run,
  withManager,
  busy,
  error,
  onFromChange,
  onToChange,
  onTitleChange,
  onObservedChange,
  onAssumedChange,
  onRunChange,
  onManagerChange,
  onSubmit,
}: {
  keys: Array<string>
  fromKey: string
  toKey: string
  title: string
  observed: string
  assumed: string
  run: boolean
  withManager: boolean
  busy: boolean
  error: string
  onFromChange: (next: string) => void
  onToChange: (next: string) => void
  onTitleChange: (next: string) => void
  onObservedChange: (next: string) => void
  onAssumedChange: (next: string) => void
  onRunChange: (next: boolean) => void
  onManagerChange: (next: boolean) => void
  onSubmit: () => void
}) {
  const { t } = useLingui()
  const ready =
    Boolean(toKey) &&
    Boolean(title.trim()) &&
    Boolean(observed.trim()) &&
    Boolean(assumed.trim())
  const fromOptions = [
    { value: 'web', label: t`Web (this console)` },
    ...keys.map((key) => ({ value: key, label: key })),
  ]
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2 sm:gap-2">
        <label className="grid min-w-0 gap-1 text-caption text-brand-muted">
          {t`From`}
          <Select
            size="lg"
            value={fromKey || 'web'}
            disabled={busy}
            onValueChange={onFromChange}
            options={fromOptions}
          />
        </label>
        <label className="grid min-w-0 gap-1 text-caption text-brand-muted">
          {t`To`}
          <Select
            size="lg"
            value={toKey}
            disabled={busy}
            onValueChange={onToChange}
            options={keys.map((key) => ({ value: key, label: key }))}
          />
        </label>
      </div>
      <label className="grid gap-1 text-caption text-brand-muted">
        {t`Title`}
        <Input
          variant="field"
          value={title}
          disabled={busy}
          maxLength={120}
          onChange={(event) => onTitleChange(event.target.value)}
          placeholder={t`What the target repository should do`}
        />
      </label>
      <label className="grid gap-1 text-caption text-brand-muted">
        {t`What you saw`}
        <Textarea
          value={observed}
          disabled={busy}
          rows={3}
          onChange={(event) => onObservedChange(event.target.value)}
          placeholder={t`The behaviour, error or data you actually observed`}
        />
      </label>
      <label className="grid gap-1 text-caption text-brand-muted">
        {t`What you assume`}
        <Textarea
          value={assumed}
          disabled={busy}
          rows={3}
          onChange={(event) => onAssumedChange(event.target.value)}
          placeholder={t`The contract or behaviour you expect — the target checks this first`}
        />
      </label>
      <div className="grid gap-1">
        <label className="flex min-h-10 items-center gap-2 text-body">
          <Checkbox
            checked={run}
            disabled={busy}
            onCheckedChange={onRunChange}
          />
          {t`Start working on it now (a headless run on the host)`}
        </label>
        <label className="flex min-h-10 items-center gap-2 text-body">
          <Checkbox
            checked={withManager}
            disabled={busy}
            onCheckedChange={onManagerChange}
          />
          {t`Open a repo-neutral Manager Session for this ticket`}
        </label>
      </div>
      {error ? (
        <p role="alert" className="text-caption text-brand-error">
          {error}
        </p>
      ) : null}
      <Button
        variant="solid"
        type="button"
        disabled={!ready || busy}
        onClick={onSubmit}
        className="min-h-11 px-3 text-body disabled:opacity-40"
      >
        {busy ? t`Creating…` : t`Create ticket`}
      </Button>
    </div>
  )
}
