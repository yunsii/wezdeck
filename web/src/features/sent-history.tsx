// Host-backed sent message history (Outbox): browse every web-sent message
// (text + uploaded images) across the current session, repo, or all sessions,
// filter unsettled / failed deliveries, and recall, resend, copy, or dismiss.
import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Check,
  Copy,
  CornerDownLeft,
  RotateCw,
  Trash2,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { Led } from '#/components/deck/led'
import type { LedTone } from '#/components/deck/led'
import { Segmented } from '#/components/deck/segmented'
import { Button } from '#/components/ui/button'
import { Sheet } from '#/components/ui/sheet'
import { trace } from '#/lib/client-trace'
import { hostRead, hostWrite } from '#/lib/runtime-client'
import { cn } from '#/lib/utils'
import { MessagePayloadView } from './chat-attachments'
import type { MessagePayload } from './composer-images'
import { jumpPending } from './console-jump-keys'
import { useSentHistory } from './sent-history-data'
import type { SentListReply, SentRecord, SentScope } from './sent-history-data'

export { sentListKey, useSentHistory } from './sent-history-data'
export type { SentListReply, SentRecord, SentScope } from './sent-history-data'

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

/** Quiet banner shown above the composer only when this session has failed / unconfirmed sends. */
export function OutboxNotice({
  unconfirmed,
  failed,
  onOpen,
}: {
  unconfirmed: number
  failed: number
  onOpen: () => void
}) {
  const { t } = useLingui()
  const total = unconfirmed + failed
  if (total === 0) return null
  return (
    <Button
      variant="plain"
      type="button"
      data-testid="outbox-notice"
      onClick={onOpen}
      className="flex w-full items-center gap-2 rounded-xl bg-brand-waiting/10 px-3 py-1.5 text-left text-meta text-brand-text"
    >
      <AlertTriangle
        size={14}
        aria-hidden
        className="shrink-0 text-brand-waiting"
      />
      <span className="min-w-0 flex-1 truncate">
        {failed > 0
          ? t`${total} sent messages need attention (${failed} failed)`
          : t`${total} sent messages not yet confirmed in transcript`}
      </span>
      <span className="shrink-0 font-medium text-brand-waiting">
        {t`Review`}
      </span>
    </Button>
  )
}

function SentHistoryRow({
  rec,
  scope,
  selected,
  writable,
  busy,
  copied,
  onSelect,
  onUse,
  onResend,
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

export function SentHistorySheet({
  session,
  writable,
  open,
  initialUnsettled = false,
  onOpenChange,
  onUse,
  onResend,
}: {
  session: string
  writable: boolean
  open: boolean
  initialUnsettled?: boolean
  onOpenChange: (open: boolean) => void
  onUse: (payload: MessagePayload) => void
  onResend?: (payload: MessagePayload) => Promise<boolean>
}) {
  const { t } = useLingui()
  const client = useQueryClient()
  const [scope, setScope] = useState<SentScope>('session')
  const [onlyUnsettled, setOnlyUnsettled] = useState(initialUnsettled)
  const [selected, setSelected] = useState(0)
  const [busyId, setBusyId] = useState('')
  const [copiedId, setCopiedId] = useState('')

  useEffect(() => {
    if (open) {
      setOnlyUnsettled(initialUnsettled)
      setSelected(0)
    }
  }, [open, initialUnsettled])

  const list = useSentHistory({ scope, session, onlyUnsettled, enabled: open })
  const items = list.data?.items ?? []
  const unsettledCount = list.data?.unsettled_count ?? 0

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select')) return
      if (event.key === 'j' || event.key === 'ArrowDown') {
        if (!items.length) return
        event.preventDefault()
        setSelected((i) => Math.min(items.length - 1, i + 1))
      } else if (event.key === 'k' || event.key === 'ArrowUp') {
        if (!items.length) return
        event.preventDefault()
        setSelected((i) => Math.max(0, i - 1))
      } else if (event.key === 'Enter' && selected < items.length) {
        event.preventDefault()
        const rec = items[selected]
        trace('sent-history', {
          action: 'recall',
          scope,
          via: 'keyboard',
          attachments: rec.attachments?.length ?? 0,
        })
        onUse({ text: rec.text, attachments: rec.attachments ?? [] })
        onOpenChange(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, items, selected, scope, onUse, onOpenChange])

  const dismissRec = async (rec: SentRecord) => {
    setBusyId(rec.id)
    try {
      await hostWrite('sent.action', { op: 'dismiss', id: rec.id })
      trace('sent-history', {
        action: 'dismiss',
        scope,
        attachments: rec.attachments?.length ?? 0,
      })
      await Promise.all([
        client.invalidateQueries({ queryKey: ['remote', 'sent'] }),
        client.invalidateQueries({ queryKey: ['remote', 'session', session] }),
      ])
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setBusyId('')
    }
  }

  const copyText = async (rec: SentRecord) => {
    try {
      await navigator.clipboard.writeText(rec.text)
      setCopiedId(rec.id)
      setTimeout(() => setCopiedId((cur) => (cur === rec.id ? '' : cur)), 1_500)
    } catch {
      toast.error(t`Copy failed`)
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t`Sent messages`}
      testId="sent-history-sheet"
      write
    >
      <div className="grid min-w-0 gap-3 px-4 pb-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented<SentScope>
            label={t`Scope`}
            value={scope}
            onChange={(next) => {
              setScope(next)
              setSelected(0)
            }}
            options={[
              { value: 'session', label: t`This session` },
              { value: 'repo', label: t`This repo` },
              { value: 'all', label: t`All` },
            ]}
          />
          {unsettledCount > 0 || onlyUnsettled ? (
            <Button
              variant={onlyUnsettled ? 'solid' : 'outline'}
              size="sm"
              type="button"
              onClick={() => {
                setOnlyUnsettled((v) => !v)
                setSelected(0)
              }}
              className="rounded-full text-meta"
            >
              {t`Unconfirmed (${unsettledCount})`}
            </Button>
          ) : null}
        </div>

        {list.isError ? (
          <p role="alert" className="py-2 text-meta text-brand-error">
            {String(list.error.message)}
          </p>
        ) : null}

        <ul className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
          {items.length === 0 && !list.isPending ? (
            <li className="py-8 text-center text-caption text-brand-muted">
              {onlyUnsettled
                ? t`All sent messages have been confirmed.`
                : t`No sent messages recorded yet.`}
            </li>
          ) : null}
          {items.map((rec, index) => (
            <SentHistoryRow
              key={rec.id}
              rec={rec}
              scope={scope}
              selected={index === selected}
              writable={writable}
              busy={busyId === rec.id}
              copied={copiedId === rec.id}
              onSelect={() => setSelected(index)}
              onUse={() => {
                trace('sent-history', {
                  action: 'recall',
                  scope,
                  attachments: rec.attachments?.length ?? 0,
                })
                onUse({ text: rec.text, attachments: rec.attachments ?? [] })
                onOpenChange(false)
              }}
              onResend={
                onResend
                  ? () => {
                      trace('sent-history', {
                        action: 'resend',
                        scope,
                        attachments: rec.attachments?.length ?? 0,
                      })
                      onOpenChange(false)
                      void onResend({
                        text: rec.text,
                        attachments: rec.attachments ?? [],
                      })
                    }
                  : undefined
              }
              onCopy={() => void copyText(rec)}
              onDismiss={() => void dismissRec(rec)}
            />
          ))}
        </ul>
      </div>
    </Sheet>
  )
}

/** Manages the `h` shortcut, `↑` empty-composer recall, and SentHistorySheet state. */
export function useSentHistoryControl({
  session,
  writable,
  onFill,
  onReplace,
  onResend,
}: {
  session: string
  writable: boolean
  onFill: (payload: MessagePayload) => void
  onReplace: (payload: MessagePayload) => void
  onResend?: (payload: MessagePayload) => Promise<boolean>
}) {
  const [open, setOpen] = useState(false)
  const [initialUnsettled, setInitialUnsettled] = useState(false)

  const openSheet = (onlyUnsettled = false) => {
    setInitialUnsettled(onlyUnsettled)
    setOpen(true)
    trace('sent-history', { action: 'open', onlyUnsettled })
  }

  const recallLatest = () => {
    void (
      hostRead('sent.list', {
        scope: 'session',
        session,
        status: 'default',
        limit: 1,
      }) as Promise<SentListReply>
    )
      .then((res) => {
        const latest = res.items.at(0)
        if (!latest) return
        onReplace({
          text: latest.text,
          attachments: latest.attachments ?? [],
        })
        trace('sent-history', {
          action: 'recall',
          scope: 'session',
          via: 'arrow-up',
          attachments: latest.attachments?.length ?? 0,
        })
      })
      .catch(() => undefined)
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        event.key !== 'h' ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        target?.closest('input, textarea, select, [contenteditable="true"]') ||
        document.querySelector('[role=dialog], [role=alertdialog]') ||
        jumpPending()
      )
        return
      event.preventDefault()
      openSheet(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return {
    openSheet,
    recallLatest,
    sheet: (
      <SentHistorySheet
        session={session}
        writable={writable}
        open={open}
        initialUnsettled={initialUnsettled}
        onOpenChange={setOpen}
        onUse={onFill}
        onResend={onResend}
      />
    ),
  }
}
