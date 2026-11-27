// Optimistic & host-backed outbox bubbles at the end of the thread: messages
// sent from the web console that the transcript does not show yet (queued),
// those it never showed once the agent went idle (lost — 未送达), and host
// paste errors (failed). Each unsettled bubble can be resent, loaded back into
// the composer for editing, or dismissed.
import { useLingui } from '@lingui/react/macro'
import { useEffect, useRef } from 'react'

import { Button } from '#/components/ui/button'
import { trace } from '#/lib/client-trace'
import { cn } from '#/lib/utils'

import { SentAttachments, withAttachmentNote } from './chat-attachments'
import type { Pending } from './chat-thread'

export function PendingBubbles({
  pending,
  onResend,
  onEdit,
  onDismiss,
}: {
  pending: Array<Pending>
  onResend?: (item: Pending) => void
  onEdit?: (item: Pending) => void
  onDismiss?: (item: Pending) => void
}) {
  const { t } = useLingui()
  // queued before the conversation opened: shown still, like its messages
  const atMount = useRef(new Set(pending.map((item) => item.sentId ?? item.at)))
  useLostTrace(pending)
  if (pending.length === 0) return null
  return (
    <div aria-label={t`Queued messages`} className="grid gap-1.5">
      {pending.map((item) => {
        const lost = item.state === 'lost'
        const failed = item.state === 'failed'
        const errorText = item.error
        const key = item.sentId ?? item.clientOp ?? item.at
        return (
          <div key={key} className="grid min-w-0 gap-1">
            {/* the user bubble itself — same box, same text and image strip
                as the message it becomes (Bubble), faded like Claude Code's
                queued input; it turns solid once the agent takes the message */}
            <div
              data-pending={item.state ?? 'queued'}
              className={cn(
                'min-w-0 rounded-xl bg-brand-text px-3.5 py-2.5 text-body leading-relaxed break-words whitespace-pre-wrap text-brand-deck',
                lost || failed ? 'opacity-80' : 'opacity-55',
                !atMount.current.has(item.sentId ?? item.at) && 'chat-in',
              )}
            >
              <SentAttachments
                text={withAttachmentNote(item.text, item.attachments)}
              />
              {item.note && !item.attachments?.length ? (
                <span className="opacity-70">
                  {item.text ? ' ' : ''}({item.note})
                </span>
              ) : null}
            </div>
            {lost || failed ? (
              <div
                role="status"
                className={cn(
                  'flex flex-wrap items-center justify-end gap-x-3 text-meta',
                  failed ? 'text-brand-error' : 'text-brand-waiting',
                )}
              >
                <span className="min-w-0 break-words">
                  {failed
                    ? errorText
                      ? t`Send failed: ${errorText}`
                      : t`Send failed`
                    : t`Not delivered: the agent went idle without it`}
                </span>
                {onResend ? (
                  <Button
                    variant="link"
                    size="none"
                    onClick={() => onResend(item)}
                  >
                    {t`Resend`}
                  </Button>
                ) : null}
                {onEdit ? (
                  <Button
                    variant="link"
                    size="none"
                    className="text-brand-text"
                    onClick={() => onEdit(item)}
                  >
                    {t`Edit`}
                  </Button>
                ) : null}
                {onDismiss ? (
                  <Button
                    variant="link"
                    size="none"
                    className="text-brand-muted"
                    onClick={() => onDismiss(item)}
                  >
                    {t`Remove`}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

/**
 * One client trace per bubble that turns lost (`wezdeck-wsl diag` pulls the
 * ring): age and length only, never the text. Also the false-alarm meter —
 * a message the agent did take but whose transcript line does not match
 * what was typed shows up here too.
 */
function useLostTrace(pending: Array<Pending>) {
  const seen = useRef(new Set<string | number>())
  const lost = pending.filter((item) => item.state === 'lost')
  const key = lost.map((item) => item.sentId ?? item.at).join(',')
  useEffect(() => {
    for (const item of lost) {
      const k = item.sentId ?? item.at
      if (seen.current.has(k)) continue
      seen.current.add(k)
      trace('send-lost', {
        age_ms: Date.now() - item.at,
        chars: item.text.length,
        attachments: item.attachments?.length ?? 0,
      })
    }
    // keyed by the set of lost bubbles, not the array identity
  }, [key])
}
