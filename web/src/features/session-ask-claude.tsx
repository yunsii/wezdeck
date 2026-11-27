// Claude's AskUserQuestion on the phone (host agent_claude_ask.go). The TUI
// takes one question at a time: a digit picks the option and moves to the
// next question; with several questions it ends on a review page that waits
// for Enter ("Submit answers"). Every action goes through usePromptAction so
// tapping an option, submitting or cancelling gives immediate loading →
// waiting feedback until the next step or host poll settles.
import { useLingui } from '@lingui/react/macro'
import { useState } from 'react'

import { Button } from '#/components/ui/button'
import { Disclosure } from '#/components/ui/disclosure'
import { cn } from '#/lib/utils'
import {
  PromptActionSpinner,
  PromptActionStatus,
  usePromptAction,
} from './prompt-action-state'
import { SessionElicitation } from './session-elicitation'
import type { Elicitation } from './session-elicitation'

const KEY_DIGITS = 4 // the host key allowlist: 1–4 (AskUserQuestion has ≤ 4)

export function ClaudeAsk({
  elicitation,
  screen,
  disabled,
  onKey,
}: {
  elicitation: Elicitation
  screen?: string
  disabled: boolean
  onKey: (key: string) => Promise<unknown> | void
}) {
  const { t } = useLingui()
  const questions = elicitation.questions
  const askId = elicitation.tool_call_id ?? ''
  // answers picked on this phone, per ask; reset when a new ask arrives
  const [picked, setPicked] = useState<{ id: string; labels: Array<string> }>({
    id: askId,
    labels: [],
  })
  const labels = picked.id === askId ? picked.labels : []
  // the pane is the truth (answered at the desk, or a pick that missed)
  const review =
    Boolean(elicitation.review) ||
    (questions.length > 1 && labels.length >= questions.length)
  const step = Math.min(labels.length, questions.length - 1)
  const current = questions.at(step)
  const total = questions.length
  const number = step + 1
  const promptKey = `${askId}:${step}:${review ? 'review' : 'ask'}`
  const { pending, run } = usePromptAction(promptKey)

  const pick = async (index: number, label: string) => {
    const stayWaiting = total <= 1
    const ok = await run(`opt-${index}`, () => onKey(String(index + 1)), {
      stayWaiting,
    })
    if (ok && !stayWaiting) {
      setPicked({ id: askId, labels: [...labels, label] })
    }
  }

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
            onClick={() => void run('submit', () => onKey('Enter'))}
            data-testid="ask-submit"
            className={cn(
              'flex min-h-12 items-center justify-center gap-2 px-3 text-body disabled:opacity-40',
              pending && 'disabled:opacity-100',
              pending?.action === 'submit' && 'ring-2 ring-brand-running/50',
            )}
          >
            {pending?.action === 'submit' ? (
              <PromptActionSpinner className="border-white/35 border-t-white" />
            ) : null}
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
          {current.options.slice(0, KEY_DIGITS).map((opt, oi) => (
            <Button
              variant="key"
              key={`${oi}-${opt.label}`}
              type="button"
              disabled={disabled || Boolean(pending)}
              onClick={() =>
                current.multi_select
                  ? void run(`opt-${oi}`, () => onKey(String(oi + 1)), {
                      kind: 'toggle',
                      stayWaiting: false,
                    })
                  : void pick(oi, opt.label)
              }
              className={cn(
                'grid min-h-12 gap-0.5 px-3 py-2.5 text-left disabled:opacity-40',
                pending && 'disabled:opacity-100',
                pending?.action === `opt-${oi}` && 'border-brand-running',
              )}
            >
              <span className="text-body font-medium">
                {oi + 1}. {opt.label}
              </span>
              {opt.description ? (
                <span className="text-caption text-brand-muted">
                  {opt.description}
                </span>
              ) : null}
            </Button>
          ))}
          {current.multi_select ? (
            <Button
              variant="key"
              type="button"
              disabled={disabled || Boolean(pending)}
              onClick={() =>
                void (async () => {
                  const stayWaiting = total <= 1
                  const ok = await run('enter', () => onKey('Enter'), {
                    stayWaiting,
                  })
                  if (ok && !stayWaiting) {
                    setPicked({ id: askId, labels: [...labels, '✓'] })
                  }
                })()
              }
              className={cn(
                'flex min-h-11 items-center justify-center gap-2 px-3 text-body disabled:opacity-40',
                pending && 'disabled:opacity-100',
                pending?.action === 'enter' && 'border-brand-running',
              )}
            >
              {pending?.action === 'enter' ? <PromptActionSpinner /> : null}
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
          onClick={() =>
            void (async () => {
              const ok = await run('cancel', () => onKey('Escape'), {
                kind: 'cancel',
              })
              if (ok) setPicked({ id: askId, labels: [] })
            })()
          }
          className={cn(
            'flex min-h-11 items-center justify-center gap-2 px-3 text-body disabled:opacity-40',
            pending && 'disabled:opacity-100',
            pending?.action === 'cancel' && 'border-brand-running',
          )}
        >
          {pending?.action === 'cancel' ? <PromptActionSpinner /> : null}
          {t`Cancel (Esc)`}
        </Button>
      </div>
      <PromptActionStatus
        pending={pending}
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
}: {
  agent?: string
  elicitation: Elicitation
  screen?: string
  disabled: boolean
  sendKey: (key: string) => Promise<unknown>
}) {
  if (agent === 'claude')
    return (
      <ClaudeAsk
        elicitation={elicitation}
        screen={screen}
        disabled={disabled}
        onKey={sendKey}
      />
    )
  return (
    <SessionElicitation
      agent={agent}
      elicitation={elicitation}
      screen={screen}
      disabled={disabled}
      sendKey={sendKey}
    />
  )
}
