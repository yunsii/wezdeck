// Top-level Manager Session panel for a ticket (P3/P4):
// - When `manager_session` exists (live or parked): renders its ChatThread via
//   `collab.manager.chat`, offers Park/Wake controls, and provides a direct
//   composer (`ticket.manager.send`, auto-resuming parked sessions).
// - When a top-level ticket has no manager session yet: offers one-tap upgrade
//   ("Start manager session") via `ticket.manager.start`.
import { useLingui } from '@lingui/react/macro'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bot, ChevronUp, Moon, Play, Send } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { Led } from '#/components/deck/led'
import { Button } from '#/components/ui/button'
import { Skeleton } from '#/components/ui/skeleton'
import { Textarea } from '#/components/ui/textarea'
import { collabKey } from '#/lib/collab-query'
import { hostRead, hostWrite } from '#/lib/runtime-client'
import type { CollabTicket } from '#/lib/runtime-contract'
import { ChatThread } from './chat-thread'
import type { Message } from './chat-thread'
import { useDeviceState } from './device-state'

type ManagerChatResponse = {
  v: number
  ok: boolean
  id: string
  state: 'live' | 'parked' | 'none'
  backend?: string
  profile?: string
  session_id?: string
  status?: string
  waiting_kind?: string
  running_kind?: string
  tmux_pane?: string
  messages: Array<Message>
  total: number
  start: number
  span: string
}

function ManagerUpgradeCard({
  pending,
  errorText,
  onStart,
}: {
  pending: boolean
  errorText: string
  onStart: () => void
}) {
  const { t } = useLingui()
  return (
    <section
      data-testid="ticket-manager-upgrade"
      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-brand-edge bg-brand-surface px-3.5 py-2.5"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Bot size={16} aria-hidden className="shrink-0 text-brand-muted" />
        <span className="text-caption text-brand-muted">
          {t`Promote this ticket to a repo-neutral Manager Session for conversational orchestration.`}
        </span>
      </div>
      <Button
        variant="outline"
        size="sm"
        type="button"
        data-testid="ticket-manager-start-button"
        disabled={pending}
        onClick={onStart}
      >
        {pending ? t`Starting…` : t`Start manager session`}
      </Button>
      {errorText ? (
        <p role="alert" className="w-full text-meta text-brand-error">
          {errorText}
        </p>
      ) : null}
    </section>
  )
}

function ManagerComposer({
  isLive,
  draft,
  pending,
  onChange,
  onSubmit,
}: {
  isLive: boolean
  draft: string
  pending: boolean
  onChange: (next: string) => void
  onSubmit: () => void
}) {
  const { t } = useLingui()
  return (
    <div className="grid gap-1.5 pt-1">
      <div className="flex items-end gap-2">
        <Textarea
          rows={2}
          value={draft}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              onSubmit()
            }
          }}
          data-testid="ticket-manager-composer"
          placeholder={
            isLive
              ? t`Message the ticket manager (Ctrl+Enter to send)…`
              : t`Type a message to wake and steer the ticket manager…`
          }
          className="min-h-11 flex-1 resize-none text-caption"
        />
        <Button
          variant="solid"
          type="button"
          data-testid="ticket-manager-send-button"
          disabled={!draft.trim() || pending}
          onClick={onSubmit}
          className="inline-flex h-10 shrink-0 items-center gap-1.5 px-3"
        >
          <Send size={14} aria-hidden />
          <span>{pending ? t`Sending…` : t`Send`}</span>
        </Button>
      </div>
    </div>
  )
}

export function TicketManagerPanel({
  ticket,
  poll,
}: {
  ticket: CollabTicket
  poll: number
}) {
  const { t } = useLingui()
  const device = useDeviceState()
  const client = useQueryClient()
  const canWrite = device.state === 'approved'
  const ms = ticket.manager_session
  const [limit, setLimit] = useState(80)
  const [draft, setDraft] = useState('')
  const [errorText, setErrorText] = useState('')

  const chatQuery = useQuery({
    queryKey: ['remote', 'collab.manager.chat', ticket.id, limit],
    enabled: Boolean(ms),
    refetchInterval: ms?.state === 'live' ? Math.min(poll, 2_000) : false,
    queryFn: async () =>
      (await hostRead('collab.manager.chat', {
        id: ticket.id,
        limit,
      })) as ManagerChatResponse,
  })

  const refreshTicket = () => {
    void client.invalidateQueries({
      queryKey: collabKey('show', { id: ticket.id }),
    })
    void client.invalidateQueries({
      queryKey: ['remote', 'collab.manager.chat', ticket.id],
    })
  }

  const startMutation = useMutation({
    mutationFn: () => hostWrite('ticket.manager.start', { id: ticket.id }),
    onSuccess: () => {
      setErrorText('')
      toast(t`Manager session started`)
      refreshTicket()
    },
    onError: (err) => {
      setErrorText(err instanceof Error ? err.message : String(err))
    },
  })

  const parkMutation = useMutation({
    mutationFn: () => hostWrite('ticket.manager.park', { id: ticket.id }),
    onSuccess: () => {
      setErrorText('')
      toast(t`Manager session parked`)
      refreshTicket()
    },
    onError: (err) => {
      setErrorText(err instanceof Error ? err.message : String(err))
    },
  })

  const sendMutation = useMutation({
    mutationFn: (text: string) =>
      hostWrite('ticket.manager.send', { id: ticket.id, text }),
    onSuccess: () => {
      setDraft('')
      setErrorText('')
      refreshTicket()
    },
    onError: (err) => {
      setErrorText(err instanceof Error ? err.message : String(err))
    },
  })

  // Child and read-only research tickets don't start their own top-level manager.
  if (!ms) {
    if (!canWrite || ticket.kind === 'child' || ticket.kind === 'research') {
      return null
    }
    return (
      <ManagerUpgradeCard
        pending={startMutation.isPending}
        errorText={errorText}
        onStart={() => startMutation.mutate()}
      />
    )
  }

  const data = chatQuery.data
  const state = data?.state ?? ms.state ?? 'parked'
  const isLive = state === 'live'
  const isBusy =
    isLive && data?.status === 'running' && data.running_kind !== 'background'
  const tone = isBusy
    ? 'running'
    : data?.status === 'waiting'
      ? 'waiting'
      : isLive
        ? 'done'
        : 'muted'
  const messages = data?.messages ?? []
  const start = data?.start ?? 0

  const submitMessage = () => {
    const clean = draft.trim()
    if (!clean || sendMutation.isPending) return
    sendMutation.mutate(clean)
  }

  return (
    <section
      data-testid="ticket-manager-panel"
      aria-label={t`Manager session`}
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2.5 rounded-2xl border border-brand-edge bg-brand-surface/70 p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Led tone={tone} size={10} />
          <span className="text-caption font-semibold text-brand-text">
            {t`Manager session`}
          </span>
          <span className="rounded-md bg-brand-deck px-1.5 py-0.5 font-mono text-meta text-brand-muted">
            {isLive ? t`live` : t`parked`}
          </span>
          {data?.profile || ms.profile ? (
            <span className="font-mono text-meta text-brand-label">
              {data?.profile ?? ms.profile}
            </span>
          ) : null}
        </div>
        {canWrite ? (
          <div className="flex items-center gap-1.5">
            {isLive ? (
              <Button
                variant="ghost"
                size="none"
                type="button"
                data-testid="ticket-manager-park-button"
                disabled={parkMutation.isPending}
                onClick={() => parkMutation.mutate()}
                className="inline-flex min-h-7 items-center gap-1 rounded-lg px-2 text-meta text-brand-muted"
              >
                <Moon size={13} aria-hidden />
                <span>{t`Park`}</span>
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="none"
                type="button"
                data-testid="ticket-manager-resume-button"
                disabled={startMutation.isPending}
                onClick={() => startMutation.mutate()}
                className="inline-flex min-h-7 items-center gap-1 rounded-lg px-2 text-meta text-brand-running"
              >
                <Play size={13} aria-hidden />
                <span>{t`Wake`}</span>
              </Button>
            )}
          </div>
        ) : null}
      </div>

      {start > 0 ? (
        <div className="flex justify-center">
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => setLimit((prev) => prev + 120)}
            className="inline-flex items-center gap-1 text-meta text-brand-muted"
          >
            <ChevronUp size={14} aria-hidden />
            <span>{t`Load earlier (${start} more)`}</span>
          </Button>
        </div>
      ) : null}

      {chatQuery.isPending ? (
        <div className="grid gap-2 py-2">
          <Skeleton className="h-4 w-2/3 rounded" />
          <Skeleton className="h-12 w-full rounded-xl" />
        </div>
      ) : messages.length === 0 ? (
        <p className="px-1 py-3 text-caption text-brand-muted">
          {isLive
            ? t`Manager session is ready — send an instruction below to start orchestrating.`
            : t`Manager session is parked. Sending a message wakes it automatically.`}
        </p>
      ) : (
        <div className="min-w-0">
          <ChatThread
            key={`mgr:${ticket.id}`}
            messages={messages}
            start={start}
            busy={Boolean(isBusy)}
            status={data?.status ?? state}
            sessionId={data?.session_id ?? ''}
          />
        </div>
      )}

      {canWrite ? (
        <ManagerComposer
          isLive={isLive}
          draft={draft}
          pending={sendMutation.isPending}
          onChange={setDraft}
          onSubmit={submitMessage}
        />
      ) : null}

      {errorText ? (
        <p role="alert" className="text-meta text-brand-error">
          {errorText}
        </p>
      ) : null}
    </section>
  )
}
