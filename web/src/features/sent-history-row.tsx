// Presentational row and status formatting for SentHistorySheet.
import { useLingui } from '@lingui/react/macro'
import {
  Check,
  Copy,
  CornerDownLeft,
  RotateCw,
  TicketPlus,
  Trash2,
} from 'lucide-react'

import { Led } from '#/components/deck/led'
import type { LedTone } from '#/components/deck/led'
import { Button } from '#/components/ui/button'
import { cn } from '#/lib/utils'
import { MessagePayloadView } from './chat-attachments'
import type { SentRecord, SentScope } from './sent-history-data'

function statusMeta(
  status: SentRecord['status'],
  t: ReturnType<typeof useLingui>['t'],
): { tone: LedTone; label: string; highlight?: string } {
  switch (status) {
    case 'confirmed':
      return { tone: 'done', label: t`Delivered` }
    case 'pasting':
    case 'pending':
      return { tone: 'running', label: t`Pending` }
    case 'unconfirmed':
      return {
        tone: 'waiting',
        label: t`Not delivered`,
        highlight: 'text-brand-waiting',
      }
    case 'failed':
      return {
        tone: 'error',
        label: t`Failed`,
        highlight: 'text-brand-error',
      }
    default:
      return { tone: 'muted', label: t`Dismissed` }
  }
}

function formatSentTime(ms: number) {
  const date = new Date(ms)
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  if (sameDay) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleString([], {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function SentHistoryRow({
  rec,
  scope,
  selected,
  writable,
  busy,
  copied,
  onSelect,
  onUse,
  onResend,
  onCreateTicket,
  onCopy,
  onDismiss,
}: {
  rec: SentRecord
  scope: SentScope
  selected: boolean
  writable: boolean
  busy: boolean
  copied: boolean
  onSelect: () => void
  onUse: () => void
  onResend?: () => void
  onCreateTicket?: () => void
  onCopy: () => void
  onDismiss: () => void
}) {
  const { t } = useLingui()
  const meta = statusMeta(rec.status, t)
  const unsettled =
    rec.status === 'pending' ||
    rec.status === 'unconfirmed' ||
    rec.status === 'failed' ||
    rec.status === 'pasting'
  return (
    <li
      data-testid="sent-history-item"
      className={cn(
        'grid min-w-0 gap-2 rounded-xl bg-brand-surface p-3',
        selected && 'ring-1 ring-brand-running/40',
      )}
      onClick={onSelect}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-brand-muted">
        <span className="inline-flex items-center gap-1.5">
          <Led tone={meta.tone} />
          <span className={cn('font-medium', meta.highlight)}>
            {meta.label}
          </span>
        </span>
        {rec.kind === 'session_new' ? (
          <span className="rounded-full bg-brand-soft px-1.5 py-px text-brand-label">
            {t`New session`}
          </span>
        ) : null}
        {scope !== 'session' && rec.repo_label ? (
          <span className="truncate text-brand-label">{rec.repo_label}</span>
        ) : null}
        <span className="ml-auto text-brand-label tabular-nums">
          {formatSentTime(rec.created_at)}
        </span>
      </div>

      <div className="min-w-0 text-body leading-relaxed break-words whitespace-pre-wrap text-brand-text">
        <MessagePayloadView
          text={rec.text}
          attachments={rec.attachments}
          tone="surface"
        />
      </div>

      {rec.error ? (
        <p className="text-meta break-words text-brand-error">{rec.error}</p>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5 text-meta">
        <Button
          variant="link"
          size="none"
          type="button"
          disabled={busy}
          onClick={onUse}
          className="inline-flex items-center gap-1 text-brand-text"
        >
          <CornerDownLeft size={13} aria-hidden />
          {t`Put in input`}
        </Button>
        {writable && onResend ? (
          <Button
            variant="link"
            size="none"
            type="button"
            disabled={busy}
            onClick={onResend}
            className="inline-flex items-center gap-1 text-brand-running"
          >
            <RotateCw size={13} aria-hidden />
            {t`Resend`}
          </Button>
        ) : null}
        {writable && onCreateTicket ? (
          <Button
            variant="link"
            size="none"
            type="button"
            disabled={busy}
            onClick={onCreateTicket}
            className="inline-flex items-center gap-1 text-brand-muted hover:text-brand-text"
          >
            <TicketPlus size={13} aria-hidden />
            {t`To ticket`}
          </Button>
        ) : null}
        {rec.text ? (
          <Button
            variant="link"
            size="none"
            type="button"
            onClick={onCopy}
            className="inline-flex items-center gap-1 text-brand-muted"
          >
            {copied ? (
              <Check size={13} aria-hidden />
            ) : (
              <Copy size={13} aria-hidden />
            )}
            {copied ? t`Copied` : t`Copy`}
          </Button>
        ) : null}
        {writable && unsettled ? (
          <Button
            variant="link"
            size="none"
            type="button"
            disabled={busy}
            onClick={onDismiss}
            className="ml-auto inline-flex items-center gap-1 text-brand-muted"
          >
            <Trash2 size={13} aria-hidden />
            {t`Dismiss`}
          </Button>
        ) : null}
      </div>
    </li>
  )
}
