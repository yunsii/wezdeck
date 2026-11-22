// Grok Ask (ask_user_question / elicitation_dialog): structured questions with
// tappable options. Number keys + Enter match the phone key allowlist and the
// usual TUI option list; bare Enter alone is easy to misfire so it is not
// offered here.
import { useLingui } from '@lingui/react/macro'

export type ElicitOption = { label: string; description?: string }
export type ElicitQuestion = {
  question: string
  options: Array<ElicitOption>
  multi_select?: boolean
}
export type Elicitation = {
  tool_call_id?: string
  questions: Array<ElicitQuestion>
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
              <button
                key={`${oi}-${opt.label.slice(0, 24)}`}
                type="button"
                disabled={disabled}
                onClick={() => onPick(qi, oi)}
                className="key-press grid min-h-12 gap-0.5 rounded-[12px] border border-brand-edge bg-brand-deck px-3 py-2.5 text-left disabled:opacity-40"
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
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onKey('Escape')}
          className="key-press min-h-11 rounded-[12px] border border-brand-edge bg-brand-deck px-3 text-[15px] disabled:opacity-40"
        >
          {t`Esc`}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onKey('C-c')}
          className="key-press min-h-11 rounded-[12px] border border-brand-edge bg-brand-deck px-3 text-[15px] disabled:opacity-40"
        >
          {t`Ctrl+C`}
        </button>
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
          <button
            key={key}
            type="button"
            disabled={disabled}
            onClick={() => onKey(key)}
            className="key-press min-h-11 min-w-11 rounded-[12px] border border-brand-edge bg-brand-deck px-3 text-[15px] disabled:opacity-40"
          >
            {label}
          </button>
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
      <details className="rounded-[16px] bg-brand-surface p-3">
        <summary className="cursor-pointer text-sm font-medium">
          {t`Current plan`}
        </summary>
        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap font-mono text-[12px] leading-snug text-brand-muted">
          {excerpt}
        </pre>
      </details>
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
        <button
          type="button"
          disabled={disabled}
          onClick={() => onKey('a')}
          className="key-press min-h-12 rounded-[12px] bg-brand-text px-3 text-[15px] font-semibold text-brand-deck disabled:opacity-40"
        >
          {t`Approve plan`}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onKey('s')}
          className="key-press min-h-12 rounded-[12px] border border-brand-edge bg-brand-deck px-3 text-[15px] disabled:opacity-40"
        >
          {t`Request changes`}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onKey('q')}
          className="key-press min-h-11 rounded-[12px] border border-brand-edge bg-brand-deck px-3 text-[15px] text-brand-muted disabled:opacity-40"
        >
          {t`Quit plan`}
        </button>
      </div>
      <p className="text-[11.5px] text-brand-label">
        {t`Approve sends a, request changes sends s (then type notes below), quit sends q — same as the Grok TUI.`}
      </p>
    </div>
  )
}
