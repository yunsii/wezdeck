// Grok / Agy Ask (ask_user_question / ask_question), Grok plan review, and the
// generic permission key strip. All interactive cards share usePromptAction +
// PromptActionStatus (prompt-action-state.tsx) so every user tap transitions
// cleanly from sending → waiting for the agent until the host poll settles.
import { useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import { Button } from '#/components/ui/button'
import { cn } from '#/lib/utils'
import { ChatMarkdown } from './chat-markdown'
import {
  PromptActionSpinner,
  PromptActionStatus,
  usePromptAction,
} from './prompt-action-state'
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
  const step =
    progress.id === askId ? Math.min(progress.step, questions.length - 1) : 0
  const current = questions[step]
  const selections = selected.id === askId ? selected.byStep : {}
  const picked = selections[step] ?? []
  const total = questions.length
  const last = step === total - 1
  const { pending, run } = usePromptAction(`${askId}:${step}`)

  const pick = async (optionIndex: number) => {
    const toggle = Boolean(current.multi_select)
    const stayWaiting = !toggle && last
    const ok = await run(
      `opt-${optionIndex}`,
      () => pickElicitationOption(optionIndex, sendKey, toggle),
      { kind: toggle ? 'toggle' : 'submit', stayWaiting },
    )
    if (!ok) return
    if (toggle) {
      const next = picked.includes(optionIndex)
        ? picked.filter((index) => index !== optionIndex)
        : [...picked, optionIndex]
      setSelected({
        id: askId,
        byStep: { ...selections, [step]: next },
      })
      return
    }
    if (!last) setProgress({ id: askId, step: step + 1 })
  }

  const submit = async () => {
    const ok = await run('submit', () => sendKey('Enter'), {
      stayWaiting: last,
    })
    if (ok && !last) setProgress({ id: askId, step: step + 1 })
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
                  pending?.action === `opt-${oi}` && 'border-brand-running',
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
              'flex min-h-11 items-center justify-center gap-2 px-3 text-body disabled:opacity-40',
              pending && 'disabled:opacity-100',
              pending?.action === 'submit' && 'ring-2 ring-brand-running/50',
            )}
          >
            {pending?.action === 'submit' ? (
              <PromptActionSpinner className="border-white/35 border-t-white" />
            ) : null}
            {t`Enter`}
          </Button>
        ) : null}
        <Button
          variant="key"
          type="button"
          disabled={disabled || Boolean(pending)}
          onClick={() =>
            void run('escape', () => sendKey('Escape'), { kind: 'cancel' })
          }
          className={cn(
            'flex min-h-11 items-center justify-center gap-2 px-3 text-body disabled:opacity-40',
            pending && 'disabled:opacity-100',
            pending?.action === 'escape' && 'border-brand-running',
          )}
        >
          {pending?.action === 'escape' ? <PromptActionSpinner /> : null}
          {t`Esc`}
        </Button>
        <Button
          variant="key"
          type="button"
          disabled={disabled || Boolean(pending)}
          onClick={() =>
            void run('ctrl-c', () => sendKey('C-c'), { kind: 'cancel' })
          }
          className={cn(
            'flex min-h-11 items-center justify-center gap-2 px-3 text-body disabled:opacity-40',
            pending && 'disabled:opacity-100',
            pending?.action === 'ctrl-c' && 'border-brand-running',
          )}
        >
          {pending?.action === 'ctrl-c' ? <PromptActionSpinner /> : null}
          {t`Ctrl+C`}
        </Button>
      </div>
      <PromptActionStatus
        pending={pending}
        loadingTestId="grok-ask-loading"
        sendingText={t`Submitting your answer…`}
        waitingText={t`Answer sent; waiting for the agent to continue…`}
        idle={
          current.multi_select
            ? t`Multiple choice: tap to toggle options, then press Enter.`
            : t`Tap an option to send its number and Enter into the agent pane.`
        }
      />
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
  onKey: (key: string) => Promise<unknown> | void
}) {
  const { t } = useLingui()
  // Keyed on screen so if the terminal moves to a follow-up screen the keys unlock.
  const { pending, run } = usePromptAction(screen ?? 'keys')
  return (
    <div
      data-write
      data-testid="session-permission-keys"
      aria-busy={Boolean(pending)}
      className={cn(
        'grid gap-2 rounded-2xl bg-brand-surface p-3',
        pending && 'pointer-events-none',
      )}
    >
      <p className="text-body font-medium">{t`The agent asks:`}</p>
      <pre className="max-h-64 overflow-auto overscroll-contain font-mono text-meta leading-snug text-brand-muted">
        {screen ?? ''}
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
            disabled={disabled || Boolean(pending)}
            onClick={() =>
              void run(key, () => onKey(key), {
                kind: key === 'Escape' || key === 'C-c' ? 'cancel' : 'submit',
              })
            }
            className={cn(
              'flex min-h-11 min-w-11 items-center justify-center gap-1.5 px-3 text-body disabled:opacity-40',
              pending && 'disabled:opacity-100',
              pending?.action === key && 'border-brand-running',
            )}
          >
            {pending?.action === key ? <PromptActionSpinner /> : null}
            {label}
          </Button>
        ))}
      </div>
      <PromptActionStatus pending={pending} />
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
  onKey: (key: string) => Promise<unknown> | void
}) {
  const { t } = useLingui()
  const { pending, run } = usePromptAction(excerpt ?? 'plan')
  // Only while the TUI is on the plan-approval bar — not while plan.md is
  // still being written under plan mode Active.
  if (!awaitingApproval) return null
  return (
    <div
      className={cn(
        'grid gap-3 rounded-2xl border border-brand-running/40 bg-brand-running/10 p-3',
        pending && 'pointer-events-none',
      )}
      data-testid="session-plan-review"
      data-write
      aria-busy={Boolean(pending)}
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
          disabled={disabled || Boolean(pending)}
          onClick={() => void run('approve', () => onKey('a'))}
          className={cn(
            'flex min-h-12 items-center justify-center gap-2 px-3 text-body disabled:opacity-40',
            pending && 'disabled:opacity-100',
            pending?.action === 'approve' && 'ring-2 ring-brand-running/50',
          )}
        >
          {pending?.action === 'approve' ? (
            <PromptActionSpinner className="border-white/35 border-t-white" />
          ) : null}
          {t`Approve plan`}
        </Button>
        <Button
          variant="key"
          type="button"
          disabled={disabled || Boolean(pending)}
          onClick={() => void run('changes', () => onKey('s'))}
          className={cn(
            'flex min-h-12 items-center justify-center gap-2 px-3 text-body disabled:opacity-40',
            pending && 'disabled:opacity-100',
            pending?.action === 'changes' && 'border-brand-running',
          )}
        >
          {pending?.action === 'changes' ? <PromptActionSpinner /> : null}
          {t`Request changes`}
        </Button>
        <Button
          variant="key"
          type="button"
          disabled={disabled || Boolean(pending)}
          onClick={() => void run('quit', () => onKey('q'), { kind: 'cancel' })}
          className={cn(
            'flex min-h-11 items-center justify-center gap-2 px-3 text-body text-brand-muted disabled:opacity-40',
            pending && 'disabled:opacity-100',
            pending?.action === 'quit' && 'border-brand-running',
          )}
        >
          {pending?.action === 'quit' ? <PromptActionSpinner /> : null}
          {t`Quit plan`}
        </Button>
      </div>
      <PromptActionStatus
        pending={pending}
        idle={t`Approve sends a, request changes sends s (then type notes below), quit sends q — same as the Grok TUI.`}
      />
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
          onKey={onKey}
        />
      ) : null}
      {data?.permission && !asking && !planReview ? (
        <PermissionCard
          agent={data.agent}
          call={data.permission}
          screen={data.screen}
          disabled={!canWrite}
          onKey={onKey}
        />
      ) : data?.waiting_kind && !asking && !planReview ? (
        <SessionPermissionKeys
          screen={data.screen}
          disabled={!canWrite}
          onKey={onKey}
        />
      ) : null}
    </div>
  )
}
