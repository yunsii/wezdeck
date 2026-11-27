// Grok / Agy Ask (ask_user_question / ask_question) and PromptPanels routing.
// Inside SessionDetail (onResolve provided), every interaction transitions
// optimistically at 0ms while queuing TUI key sequences serially; standalone
// demos (/console/me/interactions) keep usePromptAction's loading → waiting flow.
import { useLingui } from '@lingui/react/macro'
import { useState } from 'react'
import { Button } from '#/components/ui/button'
import { Disclosure } from '#/components/ui/disclosure'
import { createSerialQueue, promptFingerprint } from '#/lib/optimistic-state'
import { cn } from '#/lib/utils'
import {
  PromptActionStatus,
  promptButtonClass,
  usePromptAction,
} from './prompt-action-state'
import { AskCard } from './session-ask-claude'
import type { Detail } from './console-sessions'
import { PermissionCard } from './session-permission'
import { SessionPermissionKeys, SessionPlanReview } from './session-plan-keys'

export { SessionPermissionKeys, SessionPlanReview }

export type PromptResolveFn = (opts: {
  kind: 'prompt-submit' | 'prompt-cancel'
  promptKey: string
  execute: () => Promise<boolean>
}) => Promise<boolean>

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
  /** Agy: 1-based active question read from the pane ("Question X/Y:") */
  current_step?: number
  /** Claude: all answered, the TUI waits on its "Submit answers" page */
  review?: boolean
}

const elicitQueue = createSerialQueue()

function useElicitationState({
  agent,
  elicitation,
  sendKey,
  promptKey,
  onResolve,
}: {
  agent?: string
  elicitation: Elicitation
  sendKey: (key: string) => Promise<unknown>
  promptKey?: string
  onResolve?: PromptResolveFn
}) {
  const questions = elicitation.questions
  const askId = elicitation.tool_call_id ?? ''
  const optimistic = Boolean(onResolve)
  const queueKey = `elicit:${promptKey ?? askId}`
  const digitConfirms =
    agent === 'agy' || (agent === 'grok' && questions.length > 1)
  const [progress, setProgress] = useState({ id: askId, step: 0 })
  const [selected, setSelected] = useState<{
    id: string
    byStep: Record<number, Array<number>>
  }>({ id: askId, byStep: {} })
  const hostStep =
    elicitation.current_step && elicitation.current_step >= 1
      ? Math.min(elicitation.current_step - 1, questions.length - 1)
      : undefined
  const localStep =
    progress.id === askId ? Math.min(progress.step, questions.length - 1) : 0
  const step =
    hostStep !== undefined
      ? optimistic
        ? Math.max(hostStep, localStep)
        : hostStep
      : localStep
  const current = questions[step]
  const selections = selected.id === askId ? selected.byStep : {}
  const picked = selections[step] ?? []
  const total = questions.length
  const last = step === total - 1
  const { pending, run } = usePromptAction(`${askId}:${step}`)

  const pick = async (optionIndex: number) => {
    const toggle = Boolean(current.multi_select)
    if (optimistic && onResolve) {
      if (toggle) {
        const prevPicked = picked
        const nextPicked = prevPicked.includes(optionIndex)
          ? prevPicked.filter((index) => index !== optionIndex)
          : [...prevPicked, optionIndex]
        setSelected({
          id: askId,
          byStep: { ...selections, [step]: nextPicked },
        })
        const res = await elicitQueue.enqueue(queueKey, () =>
          pickElicitationOption(optionIndex, sendKey, true, digitConfirms),
        )
        if (!res.ok && !res.aborted) {
          setSelected((cur) => ({
            id: askId,
            byStep: {
              ...(cur.id === askId ? cur.byStep : {}),
              [step]: prevPicked,
            },
          }))
        }
        return
      }
      if (!last) {
        const prevStep = step
        setProgress({ id: askId, step: step + 1 })
        const res = await elicitQueue.enqueue(queueKey, () =>
          pickElicitationOption(optionIndex, sendKey, false, digitConfirms),
        )
        if (!res.ok && !res.aborted) setProgress({ id: askId, step: prevStep })
        return
      }
      await onResolve({
        kind: 'prompt-submit',
        promptKey: promptKey ?? askId,
        execute: async () =>
          (
            await elicitQueue.enqueue(queueKey, () =>
              pickElicitationOption(optionIndex, sendKey, false, digitConfirms),
            )
          ).ok,
      })
      return
    }
    const stayWaiting = !toggle && (last || hostStep !== undefined)
    const ok = await run(
      `opt-${optionIndex}`,
      () => pickElicitationOption(optionIndex, sendKey, toggle, digitConfirms),
      { kind: toggle ? 'toggle' : 'submit', stayWaiting },
    )
    if (!ok) return
    if (toggle) {
      const next = picked.includes(optionIndex)
        ? picked.filter((index) => index !== optionIndex)
        : [...picked, optionIndex]
      setSelected({ id: askId, byStep: { ...selections, [step]: next } })
      return
    }
    if (!last && hostStep === undefined)
      setProgress({ id: askId, step: step + 1 })
  }

  const submit = async () => {
    if (optimistic && onResolve) {
      if (!last) {
        const prevStep = step
        setProgress({ id: askId, step: step + 1 })
        const res = await elicitQueue.enqueue(
          queueKey,
          async () => (await sendKey('Enter')) !== false,
        )
        if (!res.ok && !res.aborted) setProgress({ id: askId, step: prevStep })
        return
      }
      await onResolve({
        kind: 'prompt-submit',
        promptKey: promptKey ?? askId,
        execute: async () =>
          (
            await elicitQueue.enqueue(
              queueKey,
              async () => (await sendKey('Enter')) !== false,
            )
          ).ok,
      })
      return
    }
    const ok = await run('submit', () => sendKey('Enter'), {
      stayWaiting: last || hostStep !== undefined,
    })
    if (ok && !last && hostStep === undefined)
      setProgress({ id: askId, step: step + 1 })
  }

  const cancel = (action: 'escape' | 'ctrl-c', key: 'Escape' | 'C-c') => {
    if (optimistic && onResolve) {
      elicitQueue.abort(queueKey)
      void onResolve({
        kind: 'prompt-cancel',
        promptKey: promptKey ?? askId,
        execute: async () => (await sendKey(key)) !== false,
      })
      return
    }
    void run(action, () => sendKey(key), { kind: 'cancel' })
  }

  return {
    step,
    total,
    current,
    picked,
    digitConfirms,
    pending,
    pick,
    submit,
    cancel,
  }
}

export function SessionElicitation({
  agent,
  elicitation,
  screen,
  disabled,
  sendKey,
  promptKey,
  onResolve,
}: {
  agent?: string
  elicitation: Elicitation
  screen?: string
  disabled: boolean
  sendKey: (key: string) => Promise<unknown>
  promptKey?: string
  onResolve?: PromptResolveFn
}) {
  const { t } = useLingui()
  const {
    step,
    total,
    current,
    picked,
    digitConfirms,
    pending,
    pick,
    submit,
    cancel,
  } = useElicitationState({
    agent,
    elicitation,
    sendKey,
    promptKey,
    onResolve,
  })
  const number = step + 1

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
          ? t`The agent is asking you (question ${number} of ${total})`
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
                  isPicked && 'border-brand-running bg-brand-running/10',
                  promptButtonClass(pending, `opt-${oi}`),
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
              'flex min-h-11 items-center justify-center px-3 text-body disabled:opacity-40',
              promptButtonClass(pending, 'submit', 'solid'),
            )}
          >
            {t`Enter`}
          </Button>
        ) : null}
        <Button
          variant="key"
          type="button"
          disabled={disabled || Boolean(pending)}
          onClick={() => cancel('escape', 'Escape')}
          className={cn(
            'flex min-h-11 items-center justify-center px-3 text-body disabled:opacity-40',
            promptButtonClass(pending, 'escape'),
          )}
        >
          {t`Esc`}
        </Button>
        <Button
          variant="key"
          type="button"
          disabled={disabled || Boolean(pending)}
          onClick={() => cancel('ctrl-c', 'C-c')}
          className={cn(
            'flex min-h-11 items-center justify-center px-3 text-body disabled:opacity-40',
            promptButtonClass(pending, 'ctrl-c'),
          )}
        >
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
            : digitConfirms
              ? t`Tap an option to send its number into the agent pane.`
              : t`Tap an option to send its number and Enter into the agent pane.`
        }
      />
      {screen ? (
        <Disclosure
          triggerClassName="min-h-8 text-meta font-normal text-brand-label"
          title={t`Terminal`}
        >
          <pre className="max-h-64 overflow-auto overscroll-contain font-mono text-meta leading-snug text-brand-muted">
            {screen}
          </pre>
        </Disclosure>
      ) : null}
    </div>
  )
}

/** Drive Grok / Agy Ask. A failed write stops the rest so Enter cannot submit a default. */
export async function pickElicitationOption(
  optionIndex: number,
  sendKey: (key: string) => Promise<unknown> | void,
  multiSelect = false,
  digitConfirms = false,
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
    // Multi-select digits only toggle. Agy and Grok's multi-question dialog
    // advance on a single-choice digit. Enter would answer the next question.
    if (multiSelect || digitConfirms) return true
    return put('Enter')
  }
  for (let i = 0; i < 12; i++) if (!(await put('Up'))) return false
  for (let i = 0; i < optionIndex; i++) if (!(await put('Down'))) return false
  if (multiSelect) return put('Space')
  return put('Enter')
}

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
  onResolve,
}: {
  data?: Detail
  sending: boolean
  canWrite: boolean
  onKey: (key: string) => Promise<unknown>
  onResolve?: PromptResolveFn
}) {
  const waiting = data?.status === 'waiting' || Boolean(data?.waiting_kind)
  const elicitation = waiting ? data?.elicitation : undefined
  const asking = Boolean(elicitation && elicitation.questions.length > 0)
  const planReview = waiting && Boolean(data?.plan?.awaiting_approval)
  const fingerprint = promptFingerprint(data)
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
          promptKey={fingerprint}
          onResolve={onResolve}
        />
      ) : null}
      {!asking && planReview ? (
        <SessionPlanReview
          excerpt={data?.plan?.excerpt}
          awaitingApproval
          disabled={!canWrite}
          onKey={onKey}
          promptKey={fingerprint}
          onResolve={onResolve}
        />
      ) : null}
      {data?.permission && !asking && !planReview ? (
        <PermissionCard
          agent={data.agent}
          call={data.permission}
          screen={data.screen}
          disabled={!canWrite}
          onKey={onKey}
          promptKey={fingerprint}
          onResolve={onResolve}
        />
      ) : data?.waiting_kind && !asking && !planReview ? (
        <SessionPermissionKeys
          screen={data.screen}
          disabled={!canWrite}
          onKey={onKey}
          promptKey={fingerprint}
          onResolve={onResolve}
        />
      ) : null}
    </div>
  )
}
