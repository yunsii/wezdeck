// Claude's AskUserQuestion on the phone (host agent_claude_ask.go). The TUI
// takes one question at a time: a digit picks the option and moves to the
// next question; with several questions it ends on a review page that waits
// for Enter ("Submit answers"). Grok's dialog (digit + Enter per question)
// stays in session-elicitation.tsx. Without this card the phone showed only
// the generic key strip, and after the last digit nothing said that Enter
// was still needed — the agent sat waiting.
import { useLingui } from '@lingui/react/macro'
import { useState } from 'react'

import {
  pickElicitationOption,
  SessionElicitation,
} from './session-elicitation'
import type { Elicitation } from './session-elicitation'
import { Button } from '#/components/ui/button'
import { Disclosure } from '#/components/ui/disclosure'

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
  onKey: (key: string) => void
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
  const pick = (index: number, label: string) => {
    onKey(String(index + 1))
    setPicked({ id: askId, labels: [...labels, label] })
  }
  const total = questions.length
  const number = step + 1

  return (
    <div
      className="grid gap-3 rounded-[16px] border border-brand-waiting/40 bg-brand-waiting/10 p-3"
      data-testid="session-ask"
      data-write
    >
      <p className="text-sm font-medium">
        {total > 1 && !review
          ? t`The agent is asking you (question ${number} of ${total})`
          : t`The agent is asking you`}
      </p>
      {labels.length ? (
        <ul className="grid gap-1 text-[13px]">
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
          <p className="text-[14px] leading-snug">
            {t`All questions answered. The agent waits until you submit.`}
          </p>
          <Button
            variant="solid"
            type="button"
            disabled={disabled}
            onClick={() => onKey('Enter')}
            data-testid="ask-submit"
            className="min-h-12 px-3 text-[15px] disabled:opacity-40"
          >
            {t`Submit answers`}
          </Button>
        </div>
      ) : current ? (
        <div className="grid gap-2">
          <p className="text-[15px] leading-snug font-semibold">
            {current.question}
          </p>
          {current.multi_select ? (
            <p className="text-[12px] text-brand-label">
              {t`Multiple choice: each tap toggles an option; check the screen below, then press Enter.`}
            </p>
          ) : null}
          {current.options.slice(0, KEY_DIGITS).map((opt, oi) => (
            <Button
              variant="key"
              key={`${oi}-${opt.label}`}
              type="button"
              disabled={disabled}
              onClick={() =>
                current.multi_select
                  ? onKey(String(oi + 1))
                  : pick(oi, opt.label)
              }
              className="grid min-h-12 gap-0.5 px-3 py-2.5 text-left disabled:opacity-40"
            >
              <span className="text-[15px] font-medium">
                {oi + 1}. {opt.label}
              </span>
              {opt.description ? (
                <span className="text-[12.5px] text-brand-muted">
                  {opt.description}
                </span>
              ) : null}
            </Button>
          ))}
          {current.multi_select ? (
            <Button
              variant="key"
              type="button"
              disabled={disabled}
              onClick={() => {
                onKey('Enter')
                setPicked({ id: askId, labels: [...labels, '✓'] })
              }}
              className="min-h-11 px-3 text-[15px] disabled:opacity-40"
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
          disabled={disabled}
          onClick={() => {
            onKey('Escape')
            setPicked({ id: askId, labels: [] })
          }}
          className="min-h-11 px-3 text-[15px] disabled:opacity-40"
        >
          {t`Cancel (Esc)`}
        </Button>
      </div>
      {screen ? (
        <Disclosure
          triggerClassName="min-h-9 text-[12px] font-normal text-brand-label"
          title={t`What the terminal shows`}
        >
          <pre className="max-h-48 overflow-auto font-mono text-[12px] leading-snug text-brand-muted">
            {screen.split('\n').slice(-16).join('\n')}
          </pre>
        </Disclosure>
      ) : null}
    </div>
  )
}

/** the agent's question card: Claude's step by step, Grok's dialog */
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
        onKey={(key) => void sendKey(key)}
      />
    )
  return (
    <SessionElicitation
      elicitation={elicitation}
      disabled={disabled}
      onKey={(key) => void sendKey(key)}
      onPick={(_qi, oi) => void pickElicitationOption(oi, sendKey)}
    />
  )
}
