// 新工单 from phone/desktop (`ticket.new` → `ticket create`):
// - Default "Conversational" mode: describe your goal in one box; creates the
//   ticket, starts a repo-neutral Manager Session, and sends the goal to it.
// - "Structured" mode: classic 5-field assumption gate (`From`, `To`, `Title`,
//   `Observed`, `Assumed`) with optional headless run / Manager Session.
import { useLingui } from '@lingui/react/macro'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Segmented } from '#/components/deck/segmented'
import { Button } from '#/components/ui/button'
import { Checkbox } from '#/components/ui/checkbox'
import { Input } from '#/components/ui/input'
import { Select } from '#/components/ui/select'
import { Sheet } from '#/components/ui/sheet'
import { Textarea } from '#/components/ui/textarea'
import { useLocale } from '#/lib/locale-context'
import { hostRead, hostWrite } from '#/lib/runtime-client'
import { cn } from '#/lib/utils'
import { jumpPending } from './console-jump-keys'
import { useDeviceState } from './device-state'

type Target = { key: string; path: string }
type NewTicketMode = 'chat' | 'form'

function deriveTitle(goal: string): string {
  const firstLine =
    goal
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  return firstLine.slice(0, 80).trim()
}

export function NewTicketButton() {
  const { t } = useLingui()
  const device = useDeviceState()
  const canCreate = device.state === 'approved'
  const [open, setOpen] = useState(false)
  const [round, setRound] = useState(0)
  const show = () => {
    setRound((n) => n + 1)
    setOpen(true)
  }
  useEffect(() => {
    if (!canCreate) return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        event.key !== 'n' ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.closest('input, textarea, select, [contenteditable="true"]') ||
        jumpPending()
      )
        return
      event.preventDefault()
      show()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canCreate])
  return (
    <>
      <Button
        variant="solid"
        type="button"
        disabled={!canCreate}
        onClick={show}
        data-testid="new-ticket"
        title={t`New ticket (n)`}
        className={cn(
          'inline-flex size-9 shrink-0 items-center justify-center gap-1.5 px-0 text-body md:w-auto md:px-3',
          !canCreate && 'invisible',
        )}
      >
        <Plus size={18} aria-hidden />
        <span className="sr-only md:not-sr-only">{t`New ticket`}</span>
      </Button>
      {canCreate && round > 0 ? (
        <NewTicketSheet
          key={round}
          open={open}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}

function ChatTicketFields({
  goal,
  title,
  busy,
  onGoalChange,
  onTitleChange,
}: {
  goal: string
  title: string
  busy: boolean
  onGoalChange: (next: string) => void
  onTitleChange: (next: string) => void
}) {
  const { t } = useLingui()
  return (
    <>
      <label className="grid gap-1 text-caption text-brand-muted">
        {t`Goal`}
        <Textarea
          data-testid="ticket-new-goal"
          value={goal}
          disabled={busy}
          rows={5}
          onChange={(event) => onGoalChange(event.target.value)}
          placeholder={t`Describe what you want done in plain language — the ticket Manager Session will research, draft a split proposal, and wait for your confirmation…`}
        />
      </label>
      <label className="grid gap-1 text-caption text-brand-muted">
        {t`Title (optional)`}
        <Input
          variant="field"
          value={title}
          disabled={busy}
          maxLength={120}
          onChange={(event) => onTitleChange(event.target.value)}
          placeholder={t`Auto-filled from the first line of your goal`}
        />
      </label>
      <p className="rounded-xl bg-brand-deck px-3 py-2 text-meta text-brand-muted">
        {t`Opens a repo-neutral Manager Session immediately and sends your goal so you can steer the plan conversationally.`}
      </p>
    </>
  )
}

function StructuredTicketFields({
  title,
  observed,
  assumed,
  run,
  withManager,
  busy,
  onTitleChange,
  onObservedChange,
  onAssumedChange,
  onRunChange,
  onWithManagerChange,
}: {
  title: string
  observed: string
  assumed: string
  run: boolean
  withManager: boolean
  busy: boolean
  onTitleChange: (next: string) => void
  onObservedChange: (next: string) => void
  onAssumedChange: (next: string) => void
  onRunChange: (next: boolean) => void
  onWithManagerChange: (next: boolean) => void
}) {
  const { t } = useLingui()
  return (
    <>
      <label className="grid gap-1 text-caption text-brand-muted">
        {t`Title`}
        <Input
          variant="field"
          value={title}
          disabled={busy}
          maxLength={120}
          onChange={(event) => onTitleChange(event.target.value)}
          placeholder={t`What the other repository should do`}
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
          placeholder={t`The contract or behaviour you expect from it — the target checks this first`}
        />
      </label>
      <label className="flex min-h-11 items-center gap-2 text-body">
        <Checkbox checked={run} disabled={busy} onCheckedChange={onRunChange} />
        {t`Start working on it now (a headless run on the host)`}
      </label>
      <label className="flex min-h-11 items-center gap-2 text-body">
        <Checkbox
          checked={withManager}
          disabled={busy}
          onCheckedChange={onWithManagerChange}
        />
        {t`Open a repo-neutral Manager Session for this ticket`}
      </label>
    </>
  )
}

function NewTicketSheet({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const { t } = useLingui()
  const { locale } = useLocale()
  const navigate = useNavigate()
  const client = useQueryClient()
  const targets = useQuery({
    queryKey: ['remote', 'ticket.targets'],
    queryFn: async () =>
      (await hostRead('ticket.targets', {})) as {
        targets: Array<Target>
      },
  })
  const keys = (targets.data?.targets ?? []).map((target) => target.key)
  const [mode, setMode] = useState<NewTicketMode>('chat')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [goal, setGoal] = useState('')
  const [title, setTitle] = useState('')
  const [observed, setObserved] = useState('')
  const [assumed, setAssumed] = useState('')
  const [run, setRun] = useState(false)
  const [withManager, setWithManager] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const fromKey = from || keys[0] || ''
  const toKey = to || keys.find((key) => key !== fromKey) || ''
  const resolvedTitle =
    mode === 'chat' ? title.trim() || deriveTitle(goal) : title.trim()
  const ready =
    Boolean(fromKey) &&
    Boolean(toKey) &&
    fromKey !== toKey &&
    Boolean(resolvedTitle) &&
    (mode === 'chat'
      ? Boolean(goal.trim())
      : Boolean(observed.trim()) && Boolean(assumed.trim()))

  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      const res = (await hostWrite('ticket.new', {
        from: fromKey,
        to: toKey,
        title: resolvedTitle,
        observed: mode === 'chat' ? goal.trim() : observed.trim(),
        assumed:
          mode === 'chat'
            ? 'Orchestrated via top-level Manager Session; verify assumptions against target repo before splitting.'
            : assumed.trim(),
        run: mode === 'chat' ? false : run,
      })) as { id: string; run: string; run_error?: string }
      if ((mode === 'chat' || withManager) && res.id) {
        await hostWrite('ticket.manager.start', { id: res.id }).catch(
          () => undefined,
        )
        if (mode === 'chat' && goal.trim()) {
          await hostWrite('ticket.manager.send', {
            id: res.id,
            text: goal.trim(),
          }).catch(() => undefined)
        }
      }
      await client.invalidateQueries({ queryKey: ['runtime', 'collab'] })
      onClose()
      void navigate({
        to: '/{-$locale}/console/collab/$id',
        params: { locale: locale === 'en' ? undefined : locale, id: res.id },
      })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const repoSelect = (
    value: string,
    onChange: (value: string) => void,
    label: string,
  ) => (
    <label className="grid min-w-0 gap-1 text-caption text-brand-muted">
      {label}
      <Select
        size="lg"
        value={value}
        disabled={busy}
        onValueChange={onChange}
        options={keys.map((key) => ({ value: key, label: key }))}
      />
    </label>
  )

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      title={t`New ticket`}
      testId="new-ticket-sheet"
      write
    >
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 px-4">
        <Segmented
          label={t`Creation mode`}
          value={mode}
          onChange={setMode}
          options={[
            { value: 'chat', label: t`Conversational` },
            { value: 'form', label: t`Structured form` },
          ]}
        />
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2 sm:gap-2">
          {repoSelect(fromKey, setFrom, t`From`)}
          {repoSelect(toKey, setTo, t`To`)}
        </div>
        {fromKey && fromKey === toKey ? (
          <p className="text-meta text-brand-error">
            {t`A ticket goes to another repository.`}
          </p>
        ) : null}
        {mode === 'chat' ? (
          <ChatTicketFields
            goal={goal}
            title={title}
            busy={busy}
            onGoalChange={setGoal}
            onTitleChange={setTitle}
          />
        ) : (
          <StructuredTicketFields
            title={title}
            observed={observed}
            assumed={assumed}
            run={run}
            withManager={withManager}
            busy={busy}
            onTitleChange={setTitle}
            onObservedChange={setObserved}
            onAssumedChange={setAssumed}
            onRunChange={setRun}
            onWithManagerChange={setWithManager}
          />
        )}
        {error ? (
          <p role="alert" className="text-caption text-brand-error">
            {error}
          </p>
        ) : null}
        <Button
          variant="solid"
          type="button"
          disabled={!ready || busy}
          onClick={() => void submit()}
          className="min-h-12 px-3 text-body disabled:opacity-40"
        >
          {busy
            ? t`Creating…`
            : mode === 'chat'
              ? t`Create & open manager`
              : t`Create ticket`}
        </Button>
      </div>
    </Sheet>
  )
}
