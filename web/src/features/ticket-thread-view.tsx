// A ticket's Thread as a conversation (lib/ticket-thread): the initiator on
// the right in the dark bubble, the worker on the left with who spoke, the
// time under each; the newest one marked when the ticket is waiting on you.
import { useLingui } from '@lingui/react/macro'

import { useLocale } from '#/lib/locale-context'
import { fromYou, parseThread, threadClipped } from '#/lib/ticket-thread'
import { cn } from '#/lib/utils'
import { ChatMarkdown } from './chat-markdown'

function useWho() {
  const { t } = useLingui()
  const names: Partial<Record<string, string>> = {
    initiator: t`You (initiator)`,
    worker: t`Worker`,
    'worker notes': t`Worker notes`,
    'worker challenge': t`Worker question`,
    human: t`A person`,
  }
  return (who: string) => (who ? (names[who] ?? who) : '')
}

export function TicketThread({
  text,
  waiting,
}: {
  text: string
  /** the ticket waits on you: the newest entry is the question */
  waiting: boolean
}) {
  const { t } = useLingui()
  const { locale } = useLocale()
  const whoName = useWho()
  const entries = parseThread(text)
  if (entries.length === 0)
    return (
      <div className="px-4 pb-4 text-brand-text">
        <ChatMarkdown text={text.trim()} className="text-caption" />
      </div>
    )
  const when = (at: string) => {
    const ms = Date.parse(at)
    return Number.isNaN(ms)
      ? at
      : new Date(ms).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en', {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
  }
  return (
    <ol
      aria-label={t`Thread`}
      data-testid="ticket-thread"
      className="grid gap-3 px-3 pb-4"
    >
      {threadClipped(text) ? (
        <li className="justify-self-center text-meta text-brand-label">
          {t`Earlier messages are left out here; the ticket file has them all.`}
        </li>
      ) : null}
      {entries.map((entry, i) => {
        const mine = fromYou(entry)
        const asking = waiting && i === entries.length - 1 && !mine
        return (
          <li
            key={`${entry.at}-${i}`}
            className={cn(
              'grid max-w-[92%] min-w-0 gap-1',
              mine && 'justify-self-end',
            )}
          >
            {mine ? null : (
              <span className="px-1 text-meta text-brand-label">
                {whoName(entry.who)}
              </span>
            )}
            <div
              data-asking={asking ? '' : undefined}
              className={cn(
                // anywhere, not break-word: long paths / ids must not widen the bubble
                'rounded-xl px-3.5 py-2.5 text-body leading-relaxed [overflow-wrap:anywhere]',
                mine
                  ? 'whitespace-pre-wrap bg-brand-text text-brand-deck'
                  : 'bg-brand-deck text-brand-text',
                asking && 'ring-2 ring-brand-waiting',
              )}
            >
              {mine ? entry.text : <ChatMarkdown text={entry.text} />}
            </div>
            <span
              className={cn(
                'px-1 text-meta text-brand-label tabular-nums',
                mine && 'text-right',
              )}
            >
              {asking ? `${t`Waiting for your answer`} · ` : ''}
              {when(entry.at)}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
