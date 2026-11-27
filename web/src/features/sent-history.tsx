// Host-backed sent message history (Outbox): browse every web-sent message
// (text + uploaded images) across the current session, repo, or all sessions,
// filter unsettled / failed deliveries, and recall, resend, turn into ticket,
// copy, or dismiss.
import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { OverlayScroll } from '#/components/deck/overlay-scroll'
import { Segmented } from '#/components/deck/segmented'
import { Button } from '#/components/ui/button'
import { Sheet } from '#/components/ui/sheet'
import { trace } from '#/lib/client-trace'
import { hostRead, hostWrite } from '#/lib/runtime-client'
import { cn } from '#/lib/utils'
import type { MessagePayload } from './composer-images'
import { jumpPending } from './console-jump-keys'
import { useSentHistory } from './sent-history-data'
import type { SentListReply, SentRecord, SentScope } from './sent-history-data'
import { SentHistoryRow } from './sent-history-row'

export { sentListKey, useSentHistory } from './sent-history-data'
export type { SentListReply, SentRecord, SentScope } from './sent-history-data'

const SENT_SCOPES: Array<SentScope> = ['session', 'repo', 'all']

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

function useSentSheetKeys({
  open,
  items,
  selected,
  scope,
  setScope,
  setSelected,
  onUse,
  onOpenChange,
}: {
  open: boolean
  items: Array<SentRecord>
  selected: number
  scope: SentScope
  setScope: (next: SentScope) => void
  setSelected: React.Dispatch<React.SetStateAction<number>>
  onUse: (payload: MessagePayload) => void
  onOpenChange: (open: boolean) => void
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select')) return
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        const idx = SENT_SCOPES.indexOf(scope)
        const nextIdx =
          event.key === 'ArrowRight'
            ? (idx + 1) % SENT_SCOPES.length
            : (idx - 1 + SENT_SCOPES.length) % SENT_SCOPES.length
        setScope(SENT_SCOPES[nextIdx])
        setSelected(0)
      } else if (event.key === 'j' || event.key === 'ArrowDown') {
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
  }, [open, items, selected, scope, setScope, setSelected, onUse, onOpenChange])
}

export function SentHistorySheet({
  session,
  writable,
  open,
  initialUnsettled = false,
  onOpenChange,
  onUse,
  onResend,
  onCreateTicket,
}: {
  session: string
  writable: boolean
  open: boolean
  initialUnsettled?: boolean
  onOpenChange: (open: boolean) => void
  onUse: (payload: MessagePayload) => void
  onResend?: (payload: MessagePayload) => Promise<boolean>
  onCreateTicket?: (payload: MessagePayload) => void
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

  useSentSheetKeys({
    open,
    items,
    selected,
    scope,
    setScope,
    setSelected,
    onUse,
    onOpenChange,
  })

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
      <div className="grid min-w-0 gap-3 px-4 pb-2">
        <div className="flex h-9 shrink-0 items-center justify-between gap-2 overflow-x-auto">
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
              className="shrink-0 rounded-full whitespace-nowrap text-meta"
            >
              {t`Unconfirmed (${unsettledCount})`}
            </Button>
          ) : null}
        </div>

        {/* One fixed height across all three scopes (like session-git.tsx), so
            switching session / repo / all never resizes or jumps the Sheet. */}
        <OverlayScroll
          data-testid="sent-history-body"
          className="h-[min(52dvh,26rem)]"
        >
          {list.isError ? (
            <p role="alert" className="py-2 text-meta text-brand-error">
              {String(list.error.message)}
            </p>
          ) : null}

          <ul
            className={cn(
              'grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-2 pr-0.5 transition-opacity duration-[var(--motion-short)]',
              list.isPlaceholderData && 'opacity-60',
            )}
          >
            {items.length === 0 && !list.isPending ? (
              <li className="py-12 text-center text-caption text-brand-muted">
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
                onCreateTicket={
                  onCreateTicket
                    ? () => {
                        trace('sent-history', {
                          action: 'to-ticket',
                          scope,
                          attachments: rec.attachments?.length ?? 0,
                        })
                        onOpenChange(false)
                        onCreateTicket({
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
        </OverlayScroll>
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
  onCreateTicket,
}: {
  session: string
  writable: boolean
  onFill: (payload: MessagePayload) => void
  onReplace: (payload: MessagePayload) => void
  onResend?: (payload: MessagePayload) => Promise<boolean>
  onCreateTicket?: (payload: MessagePayload) => void
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
        onCreateTicket={onCreateTicket}
      />
    ),
  }
}
