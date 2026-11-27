// Ticket body on the detail page: the agent's open question, a reply
// composer for tickets waiting on you (signed write → `ticket reply`), and
// the ticket's sections as collapsible text for reading on a phone. When the
// worker attached structured questions (questions.json), each shows as
// tappable options; the picks plus any typed note become the reply text, so
// the host side needs nothing new — `reply` archives the questions with it.
import { useLingui } from '@lingui/react/macro'
import { hostWrite } from '#/lib/runtime-client'
import { useQueryClient } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { cn } from '#/lib/utils'
import type { TicketQuestions } from '#/lib/runtime-contract'
import { useDeviceState } from './device-state'
import { Button } from '#/components/ui/button'
import { Textarea } from '#/components/ui/textarea'
import { Disclosure } from '#/components/ui/disclosure'
import { ticketDraftKey, useDraft } from '#/lib/use-draft'
import { ChatMarkdown } from './chat-markdown'
import { MessagePayloadView } from './chat-attachments'
import { TicketThread } from './ticket-thread-view'

export { openQuestion } from '#/lib/ticket-thread'

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
      <legend className="mb-2 text-body leading-snug font-semibold">
        {question.header ? (
          <span className="mr-1.5 rounded-lg bg-brand-deck px-1.5 py-0.5 text-meta font-medium text-brand-muted">
            {question.header}
          </span>
        ) : null}
        {question.question}
        {question.multi_select ? (
          <span className="ml-1 text-meta font-normal text-brand-label">
            {t`(pick any)`}
          </span>
        ) : null}
      </legend>
      {question.options.map((option, oi) => {
        const on = picked.includes(oi)
        return (
          <Button
            variant="plain"
            key={`${oi}-${option.label.slice(0, 24)}`}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(oi)}
            className={cn(
              'key-press grid min-h-12 grid-cols-[minmax(0,1fr)_1.25rem] items-center gap-2 rounded-xl border px-3 py-2.5 text-left disabled:opacity-40',
              on
                ? 'border-brand-text bg-brand-text/[0.06]'
                : 'border-brand-edge bg-brand-deck',
            )}
          >
            <span className="grid gap-0.5">
              <span className="text-body font-medium">{option.label}</span>
              {option.description ? (
                <span className="text-caption text-brand-muted">
                  {option.description}
                </span>
              ) : null}
            </span>
            {on ? <Check size={16} aria-hidden /> : null}
          </Button>
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
  // unsent reply survives leaving the page, like the session composer
  const [text, setText] = useDraft(ticketDraftKey(id))
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
      await hostWrite('reply', { id, text: answer, continue: cont })
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
    <section data-write className="grid gap-2 rounded-2xl bg-brand-surface p-4">
      <h2 className="text-title font-semibold">{t`The agent is waiting for your answer`}</h2>
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
        <ChatMarkdown text={question} />
      ) : null}
      <label htmlFor={`reply-${id}`} className="sr-only">
        {t`Your reply`}
      </label>
      <Textarea
        id={`reply-${id}`}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          // Ctrl/⌘+Enter: reply and let the agent continue (the main action)
          if (
            event.key === 'Enter' &&
            (event.ctrlKey || event.metaKey) &&
            !busy &&
            answer.trim() &&
            device.state === 'approved'
          ) {
            event.preventDefault()
            void send(true)
          }
        }}
        rows={asked.length ? 2 : 3}
        placeholder={
          asked.length
            ? t`Anything to add (optional)`
            : t`Your decision, extra context, or an answer to the challenge`
        }
        className="min-h-24 rounded-xl bg-brand-deck text-body"
      />
      {device.state !== 'approved' ? (
        <p className="text-meta text-brand-muted">
          {t`This device is not approved yet (Settings › Device access).`}
        </p>
      ) : null}
      {asked.length > 1 && unanswered > 0 && answer ? (
        <p className="text-meta text-brand-muted">
          {t`${unanswered} question(s) still unanswered; the agent sees only what you picked.`}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-meta text-brand-error">
          {error}
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <Button
          variant="plain"
          type="button"
          disabled={busy || !answer.trim() || device.state !== 'approved'}
          onClick={() => void send(false)}
          className="key-press min-h-11 rounded-xl border border-brand-edge text-body disabled:opacity-40"
        >
          {t`Reply`}
        </Button>
        <Button
          variant="solid"
          type="button"
          disabled={busy || !answer.trim() || device.state !== 'approved'}
          onClick={() => void send(true)}
          className="min-h-11 text-body disabled:opacity-40"
        >
          {t`Reply and continue`}
          <kbd className="ml-1.5 hidden text-meta opacity-60 md:inline">
            Ctrl+Enter
          </kbd>
        </Button>
      </div>
    </section>
  )
}

export function TicketSections({
  sections,
  waiting = false,
  ticketId,
  attachments = [],
}: {
  sections: Array<{ title: string; text: string }>
  /** the ticket waits on you: open the thread, mark the question */
  waiting?: boolean
  ticketId?: string
  attachments?: Array<string>
}) {
  const { t } = useLingui()
  // the ticket template's fixed headings, in the page language; any other
  // heading an agent wrote stays as written
  const names: Partial<Record<string, string>> = {
    Summary: t`Summary`,
    'Original request': t`Original request`,
    Attachments: t`Attachments`,
    Assumptions: t`Assumptions`,
    Verification: t`Verification`,
    Thread: t`Thread`,
    Decision: t`Decision`,
    Solution: t`Solution`,
  }
  const shown = sections.filter(
    (section) => section.text.replace(/^##.*$/m, '').trim().length > 0,
  )
  const hasAttachmentsSection = shown.some(
    (section) => section.title === 'Attachments',
  )
  if (shown.length === 0 && attachments.length === 0) return null
  return (
    <div className="overflow-hidden rounded-2xl bg-brand-surface">
      {shown.map((section) => {
        const body = section.text.replace(/^##.*\n?/m, '').trim()
        return (
          <Disclosure
            key={section.title}
            // the summary is what you came for: open; the rest one tap away
            defaultOpen={
              section.title === 'Summary' ||
              section.title === 'Attachments' ||
              (waiting && section.title === 'Thread')
            }
            className="border-b border-brand-edge last:border-b-0"
            triggerClassName="min-h-12 px-4 text-body font-medium"
            title={names[section.title] ?? section.title}
          >
            {section.title === 'Thread' ? (
              <TicketThread
                text={section.text.replace(/^##.*\n?/m, '')}
                waiting={waiting}
              />
            ) : section.title === 'Original request' ? (
              <div
                className="px-4 pb-4 text-body leading-relaxed break-words whitespace-pre-wrap text-brand-text"
                data-testid="ticket-original-request"
              >
                <MessagePayloadView
                  text={body}
                  attachments={attachments}
                  ticketId={ticketId}
                  tone="surface"
                />
              </div>
            ) : section.title === 'Attachments' && attachments.length > 0 ? (
              <div
                className="px-4 pb-4 text-brand-text"
                data-testid="ticket-attachments"
              >
                <MessagePayloadView
                  text=""
                  attachments={attachments}
                  ticketId={ticketId}
                  tone="surface"
                />
              </div>
            ) : (
              <div
                className="px-4 pb-4 text-brand-text"
                data-testid="ticket-section-md"
              >
                <ChatMarkdown text={body} className="text-caption" />
              </div>
            )}
          </Disclosure>
        )
      })}
      {!hasAttachmentsSection && attachments.length > 0 ? (
        <Disclosure
          defaultOpen
          className="border-b border-brand-edge last:border-b-0"
          triggerClassName="min-h-12 px-4 text-body font-medium"
          title={t`Attachments`}
        >
          <div
            className="px-4 pb-4 text-brand-text"
            data-testid="ticket-attachments"
          >
            <MessagePayloadView
              text=""
              attachments={attachments}
              ticketId={ticketId}
              tone="surface"
            />
          </div>
        </Disclosure>
      ) : null}
    </div>
  )
}
