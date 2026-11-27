// Claude's AskUserQuestion on the phone (host agent_claude_ask.go). Inside
// SessionDetail (onResolve provided), tapping an option advances steps or
// dismisses the card at 0ms while queuing keys serially; standalone demos keep
// usePromptAction's loading → waiting flow.
import { useLingui } from '@lingui/react/macro'
import { useState } from 'react'

import { Button } from '#/components/ui/button'
import { Disclosure } from '#/components/ui/disclosure'
import { createSerialQueue } from '#/lib/optimistic-state'
import { cn } from '#/lib/utils'
import {
  PromptActionStatus,
  promptButtonClass,
  usePromptAction,
} from './prompt-action-state'
import { SessionElicitation } from './session-elicitation'
import type { Elicitation, PromptResolveFn } from './session-elicitation'

const KEY_DIGITS = 4 // the host key allowlist: 1–4 (AskUserQuestion has ≤ 4)
const claudeAskQueue = createSerialQueue()

function useClaudeAskState({
  elicitation,
  onKey,
  hostPromptKey,
  onResolve,
}: {
  elicitation: Elicitation
  onKey: (key: string) => Promise<unknown> | void
  hostPromptKey?: string
  onResolve?: PromptResolveFn
}) {
  const questions = elicitation.questions
  const askId = elicitation.tool_call_id ?? ''
  const optimistic = Boolean(onResolve)
  const queueKey = `claude-ask:${hostPromptKey ?? askId}`
  const [picked, setPicked] = useState<{ id: string; labels: Array<string> }>({
    id: askId,
    labels: [],
  })
  const [multiPicked, setMultiPicked] = useState<{
    id: string
    byStep: Record<number, Array<number>>
  }>({ id: askId, byStep: {} })
  const labels = picked.id === askId ? picked.labels : []
  const review =
    Boolean(elicitation.review) ||
    (questions.length > 1 && labels.length >= questions.length)
  const step = Math.min(labels.length, questions.length - 1)
  const current = questions.at(step)
  const multiByStep = multiPicked.id === askId ? multiPicked.byStep : {}
  const multiChecked = multiByStep[step] ?? []
  const total = questions.length
  const promptKey = `${askId}:${step}:${review ? 'review' : 'ask'}`
  const { pending, run } = usePromptAction(promptKey)

  const enqueueKey = (key: string) =>
    claudeAskQueue.enqueue(queueKey, async () => (await onKey(key)) !== false)

  const pick = async (index: number, label: string) => {
    const stayWaiting = total <= 1
    if (optimistic && onResolve) {
      if (stayWaiting) {
        await onResolve({
          kind: 'prompt-submit',
          promptKey: hostPromptKey ?? askId,
          execute: async () => (await enqueueKey(String(index + 1))).ok,
        })
        return
      }
      const prevLabels = labels
      setPicked({ id: askId, labels: [...prevLabels, label] })
      const res = await enqueueKey(String(index + 1))
      if (!res.ok && !res.aborted) setPicked({ id: askId, labels: prevLabels })
      return
    }
    const ok = await run(`opt-${index}`, () => onKey(String(index + 1)), {
      stayWaiting,
    })
    if (ok && !stayWaiting) setPicked({ id: askId, labels: [...labels, label] })
  }

  const toggleMulti = async (oi: number) => {
    if (optimistic) {
      const prev = multiChecked
      const next = prev.includes(oi)
        ? prev.filter((item) => item !== oi)
        : [...prev, oi]
      setMultiPicked({ id: askId, byStep: { ...multiByStep, [step]: next } })
      const res = await enqueueKey(String(oi + 1))
      if (!res.ok && !res.aborted) {
        setMultiPicked((cur) => ({
          id: askId,
          byStep: { ...(cur.id === askId ? cur.byStep : {}), [step]: prev },
        }))
      }
      return
    }
    await run(`opt-${oi}`, () => onKey(String(oi + 1)), {
      kind: 'toggle',
      stayWaiting: false,
    })
  }

  const submitMulti = async () => {
    const stayWaiting = total <= 1
    if (optimistic && onResolve) {
      if (stayWaiting) {
        await onResolve({
          kind: 'prompt-submit',
          promptKey: hostPromptKey ?? askId,
          execute: async () => (await enqueueKey('Enter')).ok,
        })
        return
      }
      const prevLabels = labels
      setPicked({ id: askId, labels: [...prevLabels, '✓'] })
      const res = await enqueueKey('Enter')
      if (!res.ok && !res.aborted) setPicked({ id: askId, labels: prevLabels })
      return
    }
    const ok = await run('enter', () => onKey('Enter'), { stayWaiting })
    if (ok && !stayWaiting) setPicked({ id: askId, labels: [...labels, '✓'] })
  }

  const submitReview = () => {
    if (optimistic && onResolve) {
      void onResolve({
        kind: 'prompt-submit',
        promptKey: hostPromptKey ?? askId,
        execute: async () => (await enqueueKey('Enter')).ok,
      })
      return
    }
    void run('submit', () => onKey('Enter'))
  }

  const cancelAsk = () => {
    if (optimistic && onResolve) {
      claudeAskQueue.abort(queueKey)
      setPicked({ id: askId, labels: [] })
      void onResolve({
        kind: 'prompt-cancel',
        promptKey: hostPromptKey ?? askId,
        execute: async () => (await onKey('Escape')) !== false,
      })
      return
    }
    void (async () => {
      const ok = await run('cancel', () => onKey('Escape'), { kind: 'cancel' })
      if (ok) setPicked({ id: askId, labels: [] })
    })()
  }

  return {
    questions,
    labels,
    review,
    step,
    current,
    multiChecked,
    total,
    pending,
    pick,
    toggleMulti,
    submitMulti,
    submitReview,
    cancelAsk,
  }
}

export function ClaudeAsk({
  elicitation,
  screen,
  disabled,
  onKey,
  promptKey: hostPromptKey,
  onResolve,
}: {
  elicitation: Elicitation
  screen?: string
  disabled: boolean
  onKey: (key: string) => Promise<unknown> | void
  promptKey?: string
  onResolve?: PromptResolveFn
}) {
  const { t } = useLingui()
  const {
    questions,
    labels,
    review,
    step,
    current,
    multiChecked,
    total,
    pending,
    pick,
    toggleMulti,
    submitMulti,
    submitReview,
    cancelAsk,
  } = useClaudeAskState({ elicitation, onKey, hostPromptKey, onResolve })
  const number = step + 1

  return (
    <div
      className={cn(
        'grid gap-3 rounded-2xl border border-brand-waiting/40 bg-brand-waiting/10 p-3',
        pending && 'pointer-events-none',
      )}
      data-testid="session-ask"
      data-write
      aria-busy={Boolean(pending)}
    >
      <p className="text-body font-medium">
        {total > 1 && !review
          ? t`The agent is asking you (question ${number} of ${total})`
          : t`The agent is asking you`}
      </p>
      {labels.length ? (
        <ul className="grid gap-1 text-caption">
          {labels.map((label, i) => (
            <li
              key={`${i}-${label}`}
              className="grid grid-cols-[auto_minmax(0,1fr)] gap-2"
            >
              <span className="text-brand-label">
                {questions[i]?.header || questions[i]?.question}
              </span>
              <span className="font-medium break-words">{label}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {review ? (
        <div className="grid gap-2">
          <p className="text-body leading-snug">
            {t`All questions answered. The agent waits until you submit.`}
          </p>
          <Button
            variant="solid"
            type="button"
            disabled={disabled || Boolean(pending)}
            onClick={submitReview}
            data-testid="ask-submit"
            className={cn(
              'flex min-h-12 items-center justify-center px-3 text-body disabled:opacity-40',
              promptButtonClass(pending, 'submit', 'solid'),
            )}
          >
            {t`Submit answers`}
          </Button>
        </div>
      ) : current ? (
        <div className="grid gap-2">
          <p className="text-body leading-snug font-semibold">
            {current.question}
          </p>
          {current.multi_select ? (
            <p className="text-meta text-brand-label">
              {t`Multiple choice: each tap toggles an option; check the screen below, then press Enter.`}
            </p>
          ) : null}
          {current.options.slice(0, KEY_DIGITS).map((opt, oi) => {
            const isChecked = current.multi_select && multiChecked.includes(oi)
            return (
              <Button
                variant="key"
                key={`${oi}-${opt.label}`}
                type="button"
                disabled={disabled || Boolean(pending)}
                aria-pressed={current.multi_select ? isChecked : undefined}
                onClick={() =>
                  current.multi_select
                    ? void toggleMulti(oi)
                    : void pick(oi, opt.label)
                }
                className={cn(
                  'grid min-h-12 gap-0.5 px-3 py-2.5 text-left disabled:opacity-40',
                  isChecked && 'border-brand-running bg-brand-running/10',
                  promptButtonClass(pending, `opt-${oi}`),
                )}
              >
                <span className="text-body font-medium">
                  {isChecked ? '✓ ' : ''}
                  {oi + 1}. {opt.label}
                </span>
                {opt.description ? (
                  <span className="text-caption text-brand-muted">
                    {opt.description}
                  </span>
                ) : null}
              </Button>
            )
          })}
          {current.multi_select ? (
            <Button
              variant="key"
              type="button"
              disabled={disabled || Boolean(pending)}
              onClick={() => void submitMulti()}
              className={cn(
                'flex min-h-11 items-center justify-center px-3 text-body disabled:opacity-40',
                promptButtonClass(pending, 'enter'),
              )}
            >
              {t`Enter`}
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="key"
          type="button"
          disabled={disabled || Boolean(pending)}
          onClick={cancelAsk}
          className={cn(
            'flex min-h-11 items-center justify-center px-3 text-body disabled:opacity-40',
            promptButtonClass(pending, 'cancel'),
          )}
        >
          {t`Cancel (Esc)`}
        </Button>
      </div>
      <PromptActionStatus
        pending={pending}
        idle={
          !review && !current?.multi_select
            ? t`Tap an option to send its number into the agent pane.`
            : undefined
        }
        sendingText={t`Submitting your answer…`}
        waitingText={t`Answer sent; waiting for the agent to continue…`}
      />
      {screen ? (
        <Disclosure
          triggerClassName="min-h-9 text-meta font-normal text-brand-label"
          title={t`What the terminal shows`}
        >
          <pre className="max-h-48 overflow-auto font-mono text-meta leading-snug text-brand-muted">
            {screen.split('\n').slice(-16).join('\n')}
          </pre>
        </Disclosure>
      ) : null}
    </div>
  )
}

/** the agent's question card: Claude's step by step, Grok / Agy's dialog */
export function AskCard({
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
  if (agent === 'claude')
    return (
      <ClaudeAsk
        elicitation={elicitation}
        screen={screen}
        disabled={disabled}
        onKey={sendKey}
        promptKey={promptKey}
        onResolve={onResolve}
      />
    )
  return (
    <SessionElicitation
      agent={agent}
      elicitation={elicitation}
      screen={screen}
      disabled={disabled}
      sendKey={sendKey}
      promptKey={promptKey}
      onResolve={onResolve}
    />
  )
}
