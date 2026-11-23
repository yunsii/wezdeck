// Grok Ask (ask_user_question / elicitation_dialog): structured questions with
// tappable options. Number keys + Enter match the phone key allowlist and the
// usual TUI option list; bare Enter alone is easy to misfire so it is not
// offered here.
import { useLingui } from '@lingui/react/macro'
import { Button } from '#/components/ui/button'
import { Disclosure } from '#/components/ui/disclosure'
import { cn } from '#/lib/utils'
import { AskCard } from './session-ask-claude'
import type { Detail } from './console-sessions'

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
  onPick,
  onKey,
}: {
  elicitation: Elicitation
  disabled: boolean
  /** 0-based option index within the (currently single) question */
  onPick: (questionIndex: number, optionIndex: number) => void
  onKey: (key: string) => void
}) {
  const { t } = useLingui()
  return (
    <div
      className="grid gap-3 rounded-[16px] border border-brand-waiting/40 bg-brand-waiting/10 p-3"
      data-testid="session-elicitation"
      data-write
    >
      <p className="text-sm font-medium">{t`The agent is asking you`}</p>
      {elicitation.questions.map((q, qi) => (
        <div key={`${qi}-${q.question.slice(0, 24)}`} className="grid gap-2">
          <p className="text-[15px] leading-snug font-semibold">{q.question}</p>
          <div className="grid gap-2">
            {q.options.map((opt, oi) => (
              <Button
                variant="key"
                key={`${oi}-${opt.label.slice(0, 24)}`}
                type="button"
                disabled={disabled}
                onClick={() => onPick(qi, oi)}
                className="grid min-h-12 gap-0.5 px-3 py-2.5 text-left disabled:opacity-40"
              >
                <span className="text-[15px] font-medium">
                  {oi < 9 ? `${oi + 1}. ` : ''}
                  {opt.label}
                </span>
                {opt.description ? (
                  <span className="text-[12.5px] text-brand-muted">
                    {opt.description}
                  </span>
                ) : null}
              </Button>
            ))}
          </div>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="key"
          type="button"
          disabled={disabled}
          onClick={() => onKey('Escape')}
          className="min-h-11 px-3 text-[15px] disabled:opacity-40"
        >
          {t`Esc`}
        </Button>
        <Button
          variant="key"
          type="button"
          disabled={disabled}
          onClick={() => onKey('C-c')}
          className="min-h-11 px-3 text-[15px] disabled:opacity-40"
        >
          {t`Ctrl+C`}
        </Button>
      </div>
      <p className="text-[11.5px] text-brand-label">
        {t`Tap an option to send its number and Enter into the agent pane.`}
      </p>
    </div>
  )
}

/** Drive Grok Ask: digit for options 1–9, else Down from top, then Enter. */
export async function pickElicitationOption(
  optionIndex: number,
  sendKey: (key: string) => Promise<unknown> | void,
) {
  if (optionIndex >= 0 && optionIndex <= 8) {
    await sendKey(String(optionIndex + 1))
  } else {
    for (let i = 0; i < 12; i++) await sendKey('Up')
    for (let i = 0; i < optionIndex; i++) await sendKey('Down')
  }
  await sendKey('Enter')
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
    <div data-write className="grid gap-2 rounded-[16px] bg-brand-surface p-3">
      <p className="text-sm font-medium">{t`The agent asks:`}</p>
      <pre className="max-h-48 overflow-auto font-mono text-[12px] leading-snug text-brand-muted">
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
            className="min-h-11 min-w-11 px-3 text-[15px] disabled:opacity-40"
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
  if (!excerpt && !awaitingApproval) return null
  if (!awaitingApproval) {
    return (
      <Disclosure
        className="rounded-[16px] bg-brand-surface px-3"
        triggerClassName="font-medium"
        title={t`Current plan`}
      >
        <pre className="mb-3 max-h-56 overflow-auto font-mono text-[12px] leading-snug whitespace-pre-wrap text-brand-muted">
          {excerpt}
        </pre>
      </Disclosure>
    )
  }
  return (
    <div
      className="grid gap-3 rounded-[16px] border border-brand-running/40 bg-brand-running/10 p-3"
      data-testid="session-plan-review"
      data-write
    >
      <p className="text-sm font-medium">{t`Plan ready for review`}</p>
      {excerpt ? (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-[12px] bg-brand-deck p-3 font-mono text-[12px] leading-snug text-brand-muted">
          {excerpt}
        </pre>
      ) : (
        <p className="text-sm text-brand-muted">{t`No plan written yet`}</p>
      )}
      <div className="grid gap-2">
        <Button
          variant="solid"
          type="button"
          disabled={disabled}
          onClick={() => onKey('a')}
          className="min-h-12 px-3 text-[15px] disabled:opacity-40"
        >
          {t`Approve plan`}
        </Button>
        <Button
          variant="key"
          type="button"
          disabled={disabled}
          onClick={() => onKey('s')}
          className="min-h-12 px-3 text-[15px] disabled:opacity-40"
        >
          {t`Request changes`}
        </Button>
        <Button
          variant="key"
          type="button"
          disabled={disabled}
          onClick={() => onKey('q')}
          className="min-h-11 px-3 text-[15px] text-brand-muted disabled:opacity-40"
        >
          {t`Quit plan`}
        </Button>
      </div>
      <p className="text-[11.5px] text-brand-label">
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
  const elicitation = data?.elicitation
  const asking = Boolean(elicitation && elicitation.questions.length > 0)
  const planReview = Boolean(data?.plan?.awaiting_approval)
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
      {!asking && (data?.plan?.excerpt || planReview) ? (
        <SessionPlanReview
          excerpt={data?.plan?.excerpt}
          awaitingApproval={planReview}
          disabled={!canWrite}
          onKey={(key) => void onKey(key)}
        />
      ) : null}
      {data?.waiting_kind && !asking && !planReview ? (
        <SessionPermissionKeys
          screen={data.screen}
          disabled={!canWrite}
          onKey={(key) => void onKey(key)}
        />
      ) : null}
    </div>
  )
}
