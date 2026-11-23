// Ticket body on the detail page: the agent's open question, a reply
// composer for tickets waiting on you (signed write → `ticket reply`), and
// the ticket's sections as collapsible text for reading on a phone. When the
// worker attached structured questions (questions.json), each shows as
// tappable options; the picks plus any typed note become the reply text, so
// the host side needs nothing new — `reply` archives the questions with it.
import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import { Check, SquareTerminal } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { cn } from '#/lib/utils'
import { remoteLink } from '#/lib/remote-link'
import type { TicketQuestions } from '#/lib/runtime-contract'
import { useDeviceState } from './device-state'

/** Last entry of the Thread section, e.g. "worker challenge: 确认…". */
export function openQuestion(sections: Array<{ title: string; text: string }>) {
  const thread = sections.find((section) => section.title === 'Thread')
  const entries = (thread?.text ?? '')
    .split('\n')
    .filter((line) => /^- \(/.test(line.trim()))
  const last = entries.at(-1)?.trim() ?? ''
  return last.replace(/^- \([^)]*\)\s*/, '')
}

type Question = TicketQuestions['questions'][number]

/** Picks + note → the decision text the agent reads on resume. */
export function composeAnswer(
  questions: Array<Question>,
  picks: Array<Array<number>>,
  note: string,
) {
  const lines = questions.flatMap((q, qi) => {
    const labels = (picks[qi] ?? []).map((oi) => q.options[oi]?.label ?? '')
    if (labels.length === 0) return []
    const answer = labels.join('；')
    return questions.length === 1 && !note.trim()
      ? [answer]
      : [`${q.question} → ${answer}`]
  })
  if (note.trim()) lines.push(note.trim())
  return lines.join('\n')
}

function QuestionOptions({
  question,
  picked,
  disabled,
  onToggle,
}: {
  question: Question
  picked: Array<number>
  disabled: boolean
  onToggle: (optionIndex: number) => void
}) {
  const { t } = useLingui()
  return (
    <fieldset className="grid gap-2" disabled={disabled}>
      <legend className="mb-2 text-[15px] leading-snug font-semibold">
        {question.header ? (
          <span className="mr-1.5 rounded-[6px] bg-brand-deck px-1.5 py-0.5 text-[12px] font-medium text-brand-muted">
            {question.header}
          </span>
        ) : null}
        {question.question}
        {question.multi_select ? (
          <span className="ml-1 text-[12px] font-normal text-brand-label">
            {t`(pick any)`}
          </span>
        ) : null}
      </legend>
      {question.options.map((option, oi) => {
        const on = picked.includes(oi)
        return (
          <button
            key={`${oi}-${option.label.slice(0, 24)}`}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(oi)}
            className={cn(
              'key-press grid min-h-12 grid-cols-[minmax(0,1fr)_1.25rem] items-center gap-2 rounded-[12px] border px-3 py-2.5 text-left disabled:opacity-40',
              on
                ? 'border-brand-text bg-brand-text/[0.06]'
                : 'border-brand-edge bg-brand-deck',
            )}
          >
            <span className="grid gap-0.5">
              <span className="text-[15px] font-medium">{option.label}</span>
              {option.description ? (
                <span className="text-[12.5px] text-brand-muted">
                  {option.description}
                </span>
              ) : null}
            </span>
            {on ? <Check size={16} aria-hidden /> : null}
          </button>
        )
      })}
    </fieldset>
  )
}

export function TicketReply({
  id,
  question,
  questions,
}: {
  id: string
  question: string
  questions?: TicketQuestions | null
}) {
  const { t } = useLingui()
  const client = useQueryClient()
  const device = useDeviceState()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const asked = questions?.questions ?? []
  const [picks, setPicks] = useState<Array<Array<number>>>([])
  const toggle = (qi: number, oi: number) =>
    setPicks((prev) => {
      const next = asked.map((_, i) => prev[i] ?? [])
      const cur = next[qi]
      next[qi] = asked[qi].multi_select
        ? cur.includes(oi)
          ? cur.filter((x) => x !== oi)
          : [...cur, oi]
        : cur[0] === oi
          ? []
          : [oi]
      return next
    })
  const answer = asked.length ? composeAnswer(asked, picks, text) : text
  const unanswered = asked.filter((_, qi) => !picks[qi]?.length).length
  const send = async (cont: boolean) => {
    setBusy(true)
    setError('')
    try {
      await remoteLink.write('reply', { id, text: answer, continue: cont })
      setText('')
      setPicks([])
      toast(cont ? t`Replied, the agent continues` : t`Replied`)
      await client.invalidateQueries({ queryKey: ['runtime', 'collab'] })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      data-write
      className="grid gap-2 rounded-[16px] bg-brand-surface p-4"
    >
      <h2 className="text-[16px] font-semibold">{t`The agent is waiting for your answer`}</h2>
      {asked.length ? (
        <div className="grid gap-4" data-testid="ticket-questions">
          {asked.map((q, qi) => (
            <QuestionOptions
              key={`${qi}-${q.question.slice(0, 24)}`}
              question={q}
              picked={picks[qi] ?? []}
              disabled={busy}
              onToggle={(oi) => toggle(qi, oi)}
            />
          ))}
        </div>
      ) : question ? (
        <p className="text-[15px] leading-relaxed whitespace-pre-wrap">
          {question}
        </p>
      ) : null}
      <label htmlFor={`reply-${id}`} className="sr-only">
        {t`Your reply`}
      </label>
      <textarea
        id={`reply-${id}`}
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={asked.length ? 2 : 3}
        placeholder={
          asked.length
            ? t`Anything to add (optional)`
            : t`Your decision, extra context, or an answer to the challenge`
        }
        className="min-h-24 rounded-[12px] bg-brand-deck px-3 py-2 text-[16px] outline-none focus-visible:ring-2 focus-visible:ring-brand-running placeholder:text-brand-label"
      />
      {device.state !== 'approved' ? (
        <p className="text-xs text-brand-muted">
          {t`Writing is not enabled on this device yet (Settings › Write access).`}
        </p>
      ) : null}
      {asked.length > 1 && unanswered > 0 && answer ? (
        <p className="text-xs text-brand-muted">
          {t`${unanswered} question(s) still unanswered; the agent sees only what you picked.`}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-brand-error">
          {error}
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={busy || !answer.trim() || device.state !== 'approved'}
          onClick={() => void send(false)}
          className="key-press min-h-11 rounded-[12px] border border-brand-edge text-[15px] disabled:opacity-40"
        >
          {t`Reply`}
        </button>
        <button
          type="button"
          disabled={busy || !answer.trim() || device.state !== 'approved'}
          onClick={() => void send(true)}
          className="min-h-11 rounded-[12px] bg-brand-text text-[15px] font-semibold text-brand-deck disabled:opacity-40"
        >
          {t`Reply and continue`}
        </button>
      </div>
    </section>
  )
}

/**
 * 接管到 tmux: the ticket's agent conversation opens as an ordinary agent in
 * a window of the target repo's tmux session (`ticket attach`), for when a
 * tap is not enough and you want to talk it through. An open ticket is
 * session-claimed, so headless runs stop writing to the same conversation.
 */
export function TicketAttach({
  id,
  sessions,
  running,
}: {
  id: string
  sessions: Record<string, unknown>
  running: boolean
}) {
  const { t } = useLingui()
  const client = useQueryClient()
  const device = useDeviceState()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const has = Object.values(sessions).some(
    (s) =>
      s && typeof s === 'object' && 'id' in s && (s as { id?: unknown }).id,
  )
  if (!has) return null
  const attach = async () => {
    setBusy(true)
    setError('')
    try {
      const result = (await remoteLink.write('attach', { id })) as {
        tmux_session?: string
        window_name?: string
      }
      const windowName = result.window_name ?? ''
      const tmuxSession = result.tmux_session ?? ''
      toast(t`Opened in tmux: ${windowName} (${tmuxSession})`)
      await client.invalidateQueries({ queryKey: ['runtime', 'collab'] })
      await client.invalidateQueries({ queryKey: ['remote', 'sessions'] })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      data-write
      className="grid gap-2 rounded-[16px] bg-brand-surface p-4"
    >
      <button
        type="button"
        disabled={busy || running || device.state !== 'approved'}
        onClick={() => void attach()}
        className="key-press flex min-h-11 items-center justify-center gap-2 rounded-[12px] border border-brand-edge text-[15px] disabled:opacity-40"
      >
        <SquareTerminal size={17} aria-hidden />
        {busy ? t`Opening…` : t`Take over in tmux`}
      </button>
      <p className="text-[12px] text-brand-muted">
        {running
          ? t`A headless run is still going; take over when it finishes.`
          : t`Resumes this ticket's agent conversation in a window of the target repo's tmux session. Headless runs stop writing to it.`}
      </p>
      {error ? (
        <p role="alert" className="text-xs text-brand-error">
          {error}
        </p>
      ) : null}
    </section>
  )
}

export function TicketSections({
  sections,
}: {
  sections: Array<{ title: string; text: string }>
}) {
  const { t } = useLingui()
  // the ticket template's fixed headings, in the page language; any other
  // heading an agent wrote stays as written
  const names: Partial<Record<string, string>> = {
    Summary: t`Summary`,
    Assumptions: t`Assumptions`,
    Verification: t`Verification`,
    Thread: t`Thread`,
    Decision: t`Decision`,
    Solution: t`Solution`,
  }
  const shown = sections.filter(
    (section) => section.text.replace(/^##.*$/m, '').trim().length > 0,
  )
  if (shown.length === 0) return null
  return (
    <div className="overflow-hidden rounded-[16px] bg-brand-surface">
      {shown.map((section) => (
        <details
          key={section.title}
          className="group border-b border-brand-edge last:border-b-0"
        >
          <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between px-4 text-[15px] font-medium">
            {names[section.title] ?? section.title}
            <span
              aria-hidden
              className="text-brand-label transition group-open:rotate-90"
            >
              ›
            </span>
          </summary>
          <p className="px-4 pb-4 text-[14px] leading-relaxed whitespace-pre-wrap text-brand-muted">
            {section.text.replace(/^##.*\n?/m, '').trim()}
          </p>
        </details>
      ))}
    </div>
  )
}
