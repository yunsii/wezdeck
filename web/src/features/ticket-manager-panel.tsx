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
import {
  acceptTicketOptimistic,
  applyTicketOptimistic,
  rollbackTicketOptimistic,
  useTicketOptimistic,
} from '#/lib/optimistic-tickets'
import { hostRead, hostWrite } from '#/lib/runtime-client'
import type { CollabTicket } from '#/lib/runtime-contract'
import { ChatThread, settle } from './chat-thread'
import type { Message, Pending } from './chat-thread'
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

const TERMINAL_STATUSES = new Set(['shipped', 'closed', 'rejected'])

function useManagerMutations({
  ticketId,
  managerState,
  setErrorText,
  setPendingRaw,
  setDraft,
}: {
  ticketId: string
  managerState?: string | null
  setErrorText: (value: string) => void
  setPendingRaw: React.Dispatch<React.SetStateAction<Array<Pending>>>
  setDraft: React.Dispatch<React.SetStateAction<string>>
}) {
  const { t } = useLingui()
  const client = useQueryClient()
  const refreshTicket = () => {
    void client.invalidateQueries({
      queryKey: collabKey('show', { id: ticketId }),
    })
    void client.invalidateQueries({
      queryKey: ['remote', 'collab.manager.chat', ticketId],
    })
  }
  const startMutation = useMutation({
    mutationFn: async () => {
      const opId = crypto.randomUUID()
      applyTicketOptimistic({
        id: ticketId,
        opId,
        kind: 'manager-start',
        baseline: { managerState },
      })
      try {
        const res = await hostWrite('ticket.manager.start', { id: ticketId })
        acceptTicketOptimistic(ticketId, opId)
        return res
      } catch (err) {
        rollbackTicketOptimistic(
          ticketId,
          opId,
          err instanceof Error ? err.message : String(err),
        )
        throw err
      }
    },
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
    mutationFn: async () => {
      const opId = crypto.randomUUID()
      applyTicketOptimistic({
        id: ticketId,
        opId,
        kind: 'manager-park',
        baseline: { managerState },
      })
      try {
        const res = await hostWrite('ticket.manager.park', { id: ticketId })
        acceptTicketOptimistic(ticketId, opId)
        return res
      } catch (err) {
        rollbackTicketOptimistic(
          ticketId,
          opId,
          err instanceof Error ? err.message : String(err),
        )
        throw err
      }
    },
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
    mutationFn: async (vars: {
      text: string
      at: number
      opId: string
      after: number
    }) => {
      try {
        const res = await hostWrite('ticket.manager.send', {
          id: ticketId,
          text: vars.text,
          client_op: vars.opId,
        })
        acceptTicketOptimistic(ticketId, vars.opId)
        return res
      } catch (err) {
        rollbackTicketOptimistic(
          ticketId,
          vars.opId,
          err instanceof Error ? err.message : String(err),
        )
        throw err
      }
    },
    onSuccess: (_res, vars) => {
      setPendingRaw((list) =>
        list.map((item) =>
          item.clientOp === vars.opId ? { ...item, state: 'queued' } : item,
        ),
      )
      setErrorText('')
      refreshTicket()
    },
    onError: (err, vars) => {
      setPendingRaw((list) =>
        list.filter((item) => item.clientOp !== vars.opId),
      )
      setDraft((current) => current || vars.text)
      setErrorText(err instanceof Error ? err.message : String(err))
    },
  })
  return { startMutation, parkMutation, sendMutation }
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
  const canWrite = device.state === 'approved'
  const ms = ticket.manager_session
  const [limit, setLimit] = useState(80)
  const [draft, setDraft] = useState('')
  const [errorText, setErrorText] = useState('')
  const [pendingRaw, setPendingRaw] = useState<Array<Pending>>([])
  const overlay = useTicketOptimistic(ticket.id)

  const chatQuery = useQuery({
    queryKey: ['remote', 'collab.manager.chat', ticket.id, limit],
    enabled: Boolean(ms),
    refetchInterval:
      ms?.state === 'live' || overlay?.kind === 'manager-send'
        ? Math.min(poll, 2_000)
        : false,
    queryFn: async () =>
      (await hostRead('collab.manager.chat', {
        id: ticket.id,
        limit,
      })) as ManagerChatResponse,
  })

  const { startMutation, parkMutation, sendMutation } = useManagerMutations({
    ticketId: ticket.id,
    managerState: ms?.state,
    setErrorText,
    setPendingRaw,
    setDraft,
  })

  const isTerminal = TERMINAL_STATUSES.has(ticket.status ?? '')

  // Child, read-only research, and terminal (shipped/closed/rejected) tickets
  // don't offer upgrading to a new Manager Session.
  if (!ms) {
    if (
      !canWrite ||
      isTerminal ||
      ticket.kind === 'child' ||
      ticket.kind === 'research'
    ) {
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
  const state =
    overlay?.kind === 'manager-park'
      ? 'parked'
      : overlay?.kind === 'manager-start' || overlay?.kind === 'manager-send'
        ? 'live'
        : (data?.state ?? ms.state ?? 'parked')
  const isLive = state === 'live'
  const messages = data?.messages ?? []
  const start = data?.start ?? 0
  const hostBusy =
    isLive && data?.status === 'running' && data.running_kind !== 'background'
  const activePending = settle(pendingRaw, messages, start, hostBusy)
  const hasActivePending = activePending.some(
    (item) => item.state !== 'lost' && item.state !== 'failed',
  )
  const isBusy =
    hostBusy || hasActivePending || overlay?.kind === 'manager-send'
  const tone = isBusy
    ? 'running'
    : data?.status === 'waiting'
      ? 'waiting'
      : isLive
        ? 'done'
        : 'muted'

  const submitMessage = () => {
    const clean = draft.trim()
    if (!clean) return
    const at = Date.now()
    const opId = crypto.randomUUID()
    const after = start + messages.length
    setDraft('')
    setErrorText('')
    setPendingRaw((list) => [
      ...list,
      { text: clean, at, after, clientOp: opId, state: 'sending' },
    ])
    applyTicketOptimistic({
      id: ticket.id,
      opId,
      kind: 'manager-send',
      createdAt: at,
      baseline: { managerState: data?.state ?? ms.state },
    })
    sendMutation.mutate({ text: clean, at, opId, after })
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
        {canWrite && (!isTerminal || isLive) ? (
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
      ) : messages.length === 0 && activePending.length === 0 ? (
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
            pending={pendingRaw}
            status={isBusy ? 'running' : (data?.status ?? state)}
            sessionId={data?.session_id ?? ''}
          />
        </div>
      )}

      {canWrite && !isTerminal ? (
        <ManagerComposer
          isLive={isLive}
          draft={draft}
          pending={false}
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
