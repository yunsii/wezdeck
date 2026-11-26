// Grok Ask (ask_user_question / elicitation_dialog): structured questions with
// tappable options. Grok shows one question at a time: digits 1–9 select (or
// toggle a multi-select), arrows cover later options, and Enter advances or
// submits. Local pending state gives immediate feedback through the key writes
// and the host poll that closes the card.
import { useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import { Button } from '#/components/ui/button'
import { cn } from '#/lib/utils'
import { ChatMarkdown } from './chat-markdown'
import { AskCard } from './session-ask-claude'
import type { Detail } from './console-sessions'
import { PermissionCard } from './session-permission'

export type ElicitOption = { label: string; description?: string }
export type ElicitQuestion = {
  header?: string
  question: string
  options: Array<ElicitOption>
  multi_select?: boolean
}
export type Elicitation = {
  tool_call_id?: string
  questions: Array<ElicitQuestion>
  /** Claude: all answered, the TUI waits on its "Submit answers" page */
  review?: boolean
}

type AskPending = {
  id: string
  step: number
  option?: number
  phase: 'sending' | 'waiting'
  toggle: boolean
}

export function SessionElicitation({
  elicitation,
  disabled,
  sendKey,
}: {
  elicitation: Elicitation
  disabled: boolean
  sendKey: (key: string) => Promise<unknown>
}) {
  const { t } = useLingui()
  const questions = elicitation.questions
  const askId = elicitation.tool_call_id ?? ''
  const [progress, setProgress] = useState({ id: askId, step: 0 })
  const [selected, setSelected] = useState<{
    id: string
    byStep: Record<number, Array<number>>
  }>({ id: askId, byStep: {} })
  const [pendingBy, setPendingBy] = useState<AskPending | null>(null)
  const step =
    progress.id === askId ? Math.min(progress.step, questions.length - 1) : 0
  const current = questions[step]
  const pending = pendingBy?.id === askId ? pendingBy : null
  const selections = selected.id === askId ? selected.byStep : {}
  const picked = selections[step] ?? []
  const total = questions.length
  const last = step === total - 1

  const advance = () => {
    if (last) {
      setPendingBy((now) => (now ? { ...now, phase: 'waiting' } : now))
      return
    }
    setPendingBy(null)
    setProgress({ id: askId, step: step + 1 })
  }
  const pick = async (optionIndex: number) => {
    if (pending) return
    const toggle = Boolean(current.multi_select)
    setPendingBy({
      id: askId,
      step,
      option: optionIndex,
      phase: 'sending',
      toggle,
    })
    const ok = await pickElicitationOption(optionIndex, sendKey, toggle)
    if (!ok) {
      setPendingBy(null)
      return
    }
    if (toggle) {
      const next = picked.includes(optionIndex)
        ? picked.filter((index) => index !== optionIndex)
        : [...picked, optionIndex]
      setSelected({
        id: askId,
        byStep: { ...selections, [step]: next },
      })
      setPendingBy(null)
      return
    }
    advance()
  }
  const submit = async () => {
    if (pending) return
    setPendingBy({ id: askId, step, phase: 'sending', toggle: false })
    if ((await sendKey('Enter')) === false) {
      setPendingBy(null)
      return
    }
    advance()
  }

  return (
    <div
      className={cn(
        'grid gap-3 rounded-2xl border border-brand-waiting/40 bg-brand-waiting/10 p-3',
        pending && 'pointer-events-none',
      )}
      data-testid="session-elicitation"
      data-write
      aria-busy={Boolean(pending)}
    >
      <p className="text-body font-medium">
        {total > 1
          ? t`The agent is asking you (question ${step + 1} of ${total})`
          : t`The agent is asking you`}
      </p>
      <div className="grid gap-2">
        <p className="text-body leading-snug font-semibold">
          {current.question}
        </p>
        <div className="grid gap-2">
          {current.options.map((opt, oi) => {
            const isPicked = picked.includes(oi)
            return (
              <Button
                variant="key"
                key={`${oi}-${opt.label.slice(0, 24)}`}
                type="button"
                disabled={disabled || Boolean(pending)}
                aria-pressed={current.multi_select ? isPicked : undefined}
                onClick={() => void pick(oi)}
                className={cn(
                  'grid min-h-12 gap-0.5 px-3 py-2.5 text-left disabled:opacity-40',
                  pending && 'disabled:opacity-100',
                  isPicked && 'border-brand-running bg-brand-running/10',
                  pending?.option === oi && 'border-brand-running',
                )}
              >
                <span className="text-body font-medium">
                  {current.multi_select && isPicked ? '✓ ' : ''}
                  {oi < 9 ? `${oi + 1}. ` : ''}
                  {opt.label}
                </span>
                {opt.description ? (
                  <span className="text-caption text-brand-muted">
                    {opt.description}
                  </span>
                ) : null}
              </Button>
            )
          })}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {current.multi_select ? (
          <Button
            variant="solid"
            type="button"
            data-testid="grok-ask-submit"
            disabled={disabled || Boolean(pending)}
            onClick={() => void submit()}
            className={cn(
              'min-h-11 px-3 text-body disabled:opacity-40',
              pending && 'disabled:opacity-100',
            )}
          >
            {t`Enter`}
          </Button>
        ) : null}
        <Button
          variant="key"
          type="button"
          disabled={disabled || Boolean(pending)}
          onClick={() => void sendKey('Escape')}
          className="min-h-11 px-3 text-body disabled:opacity-40"
        >
          {t`Esc`}
        </Button>
        <Button
          variant="key"
          type="button"
          disabled={disabled || Boolean(pending)}
          onClick={() => void sendKey('C-c')}
          className="min-h-11 px-3 text-body disabled:opacity-40"
        >
          {t`Ctrl+C`}
        </Button>
      </div>
      <p
        role={pending ? 'status' : undefined}
        aria-live={pending ? 'polite' : undefined}
        data-testid={pending ? 'grok-ask-loading' : undefined}
        className={cn(
          'flex min-h-5 items-center gap-2 text-meta',
          pending ? 'text-brand-running' : 'text-brand-label',
        )}
      >
        {pending ? (
          <>
            <span className="inline-block size-3.5 animate-spin rounded-full border-2 border-brand-border border-t-brand-running" />
            {pending.phase === 'waiting'
              ? t`Answer sent; waiting for the agent to continue…`
              : pending.toggle
                ? t`Updating your selection…`
                : t`Submitting your answer…`}
          </>
        ) : current.multi_select ? (
          t`Multiple choice: tap to toggle options, then press Enter.`
        ) : (
          t`Tap an option to send its number and Enter into the agent pane.`
        )}
      </p>
    </div>
  )
}

/** Drive Grok Ask. A failed write stops the rest so Enter cannot submit a default. */
export async function pickElicitationOption(
  optionIndex: number,
  sendKey: (key: string) => Promise<unknown> | void,
  multiSelect = false,
): Promise<boolean> {
  const put = async (key: string) => {
    if ((await sendKey(key)) === false) return false
    // A relay write only means tmux accepted the key. Grok needs a render turn
    // between a digit / Enter and the next semantic action: five writes in
    // 270ms made a real multi-select submit its default and queued "23" as a
    // later prompt. Arrow repeats are safe to keep short.
    const settle = key === 'Up' || key === 'Down' ? 25 : 180
    await new Promise((resolve) => setTimeout(resolve, settle))
    return true
  }
  if (optionIndex >= 0 && optionIndex <= 8) {
    if (!(await put(String(optionIndex + 1)))) return false
  } else {
    for (let i = 0; i < 12; i++) if (!(await put('Up'))) return false
    for (let i = 0; i < optionIndex; i++) if (!(await put('Down'))) return false
    if (multiSelect) return put('Space')
  }
  // Multi-select digits only toggle; Enter belongs to the explicit submit button.
  if (multiSelect) return true
  return put('Enter')
}

/** Permission-prompt strip (Claude-style 1/2/3/Enter) when Ask payload is absent. */
export function SessionPermissionKeys({
  screen,
  disabled,
  onKey,
}: {
  screen?: string
  disabled: boolean
  onKey: (key: string) => void
}) {
  const { t } = useLingui()
  return (
    <div data-write className="grid gap-2 rounded-2xl bg-brand-surface p-3">
      <p className="text-body font-medium">{t`The agent asks:`}</p>
      <pre className="max-h-48 overflow-auto font-mono text-meta leading-snug text-brand-muted">
        {(screen ?? '').split('\n').slice(-14).join('\n')}
      </pre>
      <div className="flex flex-wrap gap-2">
        {[
          ['1', '1'],
          ['2', '2'],
          ['3', '3'],
          ['Enter', t`Enter`],
          ['Escape', t`Esc`],
          ['C-c', t`Ctrl+C`],
        ].map(([key, label]) => (
          <Button
            variant="key"
            key={key}
            type="button"
            disabled={disabled}
            onClick={() => onKey(key)}
            className="min-h-11 min-w-11 px-3 text-body disabled:opacity-40"
          >
            {label}
          </Button>
        ))}
      </div>
    </div>
  )
}

/** Grok plan review: a=approve, s=request changes, q=quit (TUI plan approval bar). */
export function SessionPlanReview({
  excerpt,
  awaitingApproval,
  disabled,
  onKey,
}: {
  excerpt?: string
  awaitingApproval?: boolean
  disabled: boolean
  onKey: (key: string) => void
}) {
  const { t } = useLingui()
  // Only while the TUI is on the plan-approval bar — not while plan.md is
  // still being written under plan mode Active.
  if (!awaitingApproval) return null
  return (
    <div
      className="grid gap-3 rounded-2xl border border-brand-running/40 bg-brand-running/10 p-3"
      data-testid="session-plan-review"
      data-write
    >
      <p className="text-body font-medium">{t`Plan ready for review`}</p>
      {excerpt ? (
        <div className="max-h-96 overflow-y-auto rounded-xl bg-brand-deck px-3 py-2">
          <ChatMarkdown text={excerpt} />
        </div>
      ) : (
        <p className="text-caption text-brand-muted">{t`No plan written yet`}</p>
      )}
      <div className="grid gap-2">
        <Button
          variant="solid"
          type="button"
          disabled={disabled}
          onClick={() => onKey('a')}
          className="min-h-12 px-3 text-body disabled:opacity-40"
        >
          {t`Approve plan`}
        </Button>
        <Button
          variant="key"
          type="button"
          disabled={disabled}
          onClick={() => onKey('s')}
          className="min-h-12 px-3 text-body disabled:opacity-40"
        >
          {t`Request changes`}
        </Button>
        <Button
          variant="key"
          type="button"
          disabled={disabled}
          onClick={() => onKey('q')}
          className="min-h-11 px-3 text-body text-brand-muted disabled:opacity-40"
        >
          {t`Quit plan`}
        </Button>
      </div>
      <p className="text-meta text-brand-label">
        {t`Approve sends a, request changes sends s (then type notes below), quit sends q — same as the Grok TUI.`}
      </p>
    </div>
  )
}

/**
 * What the agent waits on — an Ask, a plan to review, a permission prompt —
 * as keys. While a key is on its way the panel keeps its look and only stops
 * taking taps: dimming it per key (disabled) flashed the whole panel, several
 * times for an Ask answer sent as a run of keys. Dimmed means this device
 * cannot write.
 */
/** True when PromptPanels renders an interactive confirmation / question / plan card. */
export function hasPromptPanel(data?: Detail): boolean {
  if (!data) return false
  const waiting = data.status === 'waiting' || Boolean(data.waiting_kind)
  const asking = Boolean(waiting && data.elicitation?.questions.length)
  const planReview = Boolean(waiting && data.plan?.awaiting_approval)
  return (
    asking ||
    planReview ||
    Boolean(data.permission) ||
    Boolean(data.waiting_kind)
  )
}

export function PromptPanels({
  data,
  sending,
  canWrite,
  onKey,
}: {
  data?: Detail
  sending: boolean
  canWrite: boolean
  onKey: (key: string) => Promise<unknown>
}) {
  // Host gates elicitation / plan.awaiting_approval on attention waiting;
  // also hide here so a stale poll cache after Ctrl+C cannot keep the card.
  const waiting = data?.status === 'waiting' || Boolean(data?.waiting_kind)
  const elicitation = waiting ? data?.elicitation : undefined
  const asking = Boolean(elicitation && elicitation.questions.length > 0)
  // Plan card only when the TUI is on the approval bar (not while writing).
  const planReview = waiting && Boolean(data?.plan?.awaiting_approval)
  return (
    <div
      aria-busy={sending}
      className={cn('contents', sending && 'pointer-events-none')}
    >
      {data && asking && elicitation ? (
        <AskCard
          agent={data.agent}
          elicitation={elicitation}
          screen={data.screen}
          disabled={!canWrite}
          sendKey={onKey}
        />
      ) : null}
      {!asking && planReview ? (
        <SessionPlanReview
          excerpt={data?.plan?.excerpt}
          awaitingApproval
          disabled={!canWrite}
          onKey={(key) => void onKey(key)}
        />
      ) : null}
      {data?.permission && !asking && !planReview ? (
        <PermissionCard
          agent={data.agent}
          call={data.permission}
          screen={data.screen}
          disabled={!canWrite}
          onKey={(key) => void onKey(key)}
        />
      ) : data?.waiting_kind && !asking && !planReview ? (
        <SessionPermissionKeys
          screen={data.screen}
          disabled={!canWrite}
          onKey={(key) => void onKey(key)}
        />
      ) : null}
    </div>
  )
}
