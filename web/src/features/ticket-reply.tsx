// Ticket body on the detail page: the agent's open question, a reply
// composer for tickets waiting on you (signed write → `ticket reply`), and
// the ticket's sections as collapsible text for reading on a phone.
import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'

import { remoteLink } from '#/lib/remote-link'
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

export function TicketReply({
  id,
  question,
}: {
  id: string
  question: string
}) {
  const { t } = useLingui()
  const client = useQueryClient()
  const device = useDeviceState()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const send = async (cont: boolean) => {
    setBusy(true)
    setError('')
    try {
      await remoteLink.write('reply', { id, text, continue: cont })
      setText('')
      toast(cont ? t`Replied, the agent continues` : t`Replied`)
      await client.invalidateQueries({ queryKey: ['runtime', 'collab'] })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="grid gap-2 rounded-[16px] bg-brand-surface p-4">
      <h2 className="text-[16px] font-semibold">{t`The agent is waiting for your answer`}</h2>
      {question ? (
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
        rows={3}
        placeholder={t`Your decision, extra context, or an answer to the challenge`}
        className="min-h-24 rounded-[12px] bg-brand-deck px-3 py-2 text-[16px] outline-none focus-visible:ring-2 focus-visible:ring-brand-running placeholder:text-brand-label"
      />
      {device.state !== 'approved' ? (
        <p className="text-xs text-brand-muted">
          {t`Writing is not enabled on this phone yet (Settings › Phone writing).`}
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
          disabled={busy || !text.trim() || device.state !== 'approved'}
          onClick={() => void send(false)}
          className="key-press min-h-11 rounded-[12px] border border-brand-edge text-[15px] disabled:opacity-40"
        >
          {t`Reply`}
        </button>
        <button
          type="button"
          disabled={busy || !text.trim() || device.state !== 'approved'}
          onClick={() => void send(true)}
          className="min-h-11 rounded-[12px] bg-brand-text text-[15px] font-semibold text-brand-deck disabled:opacity-40"
        >
          {t`Reply and continue`}
        </button>
      </div>
    </section>
  )
}

export function TicketSections({
  sections,
}: {
  sections: Array<{ title: string; text: string }>
}) {
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
            {section.title}
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
