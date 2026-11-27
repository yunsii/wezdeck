// 会话: every live agent session on the host (from attention.json via the
// relay), its conversation, and — with an approved device key — a composer
// that pastes into the session's own tmux TUI. Guards live on the host
// (remote_session.go); the page explains them before the user hits them.
import { useLingui } from '@lingui/react/macro'
import { useQueryClient } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'

import type { LedTone } from '#/components/deck/led'
import { useLocale } from '#/lib/locale-context'
import { useGoBack } from '#/lib/go-back'
import { trace } from '#/lib/client-trace'
import { forgetOpened } from '#/lib/last-opened'
import { useIsWidePhoneFirst } from '#/lib/use-media'
import { useDeviceState } from './device-state'
import { SessionHeader } from './session-header'
import { useChatScroll } from './chat-scroll'
import { JumpLatest } from './chat-controls'
import { landingPolicy } from './chat-landing'
import { useSessionPaging } from './chat-preload'
import { useWhileShown } from './session-while-shown'
import { settle } from './chat-thread'
import { HostFileProvider } from './host-file-sheet'
import { ComposerBox, useComposer } from './session-composer'
import type { Composer, Outgoing } from './session-composer'
import { hasPromptPanel } from './session-elicitation'
import {
  mergeOutboxPending,
  useFollowReplacement,
  useSessionWrites,
} from './session-send'
import { OutboxNotice, useSentHistoryControl } from './sent-history'
import { QuickTicketSheet } from './ticket-quick-form'
import type { MessagePayload } from './composer-images'
import { toast } from 'sonner'
import { useResumeSheet } from './session-commands'
import { SessionStatusBar } from './session-statusbar'
import type { BgTask } from './session-background'
import type { Message } from './chat-thread'
import type { SessionCard } from './session-card'
import { detailKey, readDetail, useSessionDetail } from './session-detail-read'
import {
  SessionComposerNotices,
  SessionThreadBody,
} from './session-detail-parts'
import type {
  AccountLimits,
  AgentCapabilities,
  Detail,
  RateWindow,
  TitleHistoryItem,
  Usage,
} from './session-detail-types'
import {
  LAST_SESSION_KEY,
  clearSessionMissing,
  hideDeletedSessions,
  isMissingSessionError,
  markSessionMissing,
} from './session-delete-state'
import type { SessionsReply } from './session-delete-state'

export type { SessionCard }
export { useSessions } from './session-delete-state'

/** waiting on a human: a permission / question prompt, or the turn asked you */
export const needsYou = (row: { status: string; waiting_kind?: string }) =>
  Boolean(row.waiting_kind) || row.status === 'waiting'

/** turn finished while you were away — desk ✓ done until focus-ack / clear */
export const isDoneUnread = (row: { status: string }) => row.status === 'done'

/** list unread / tab badge: waiting on you, or done and not yet seen */
export const needsAttention = (row: {
  status: string
  waiting_kind?: string
}) => needsYou(row) || isDoneUnread(row)

/** Last prompt the user typed; harness-injected ones (<task-notification>…) are not. */
export const humanPrompt = (prompt?: string) =>
  prompt && !prompt.trim().startsWith('<') ? prompt : ''

export type { BgTask }

/** Mid-turn. A session that only waits on background tasks takes input. */
export const isBusy = (row: { status: string; running_kind?: string }) =>
  row.status === 'running' && row.running_kind !== 'background'

export type {
  AccountLimits,
  AgentCapabilities,
  Detail,
  RateWindow,
  TitleHistoryItem,
  Usage,
}

export function sessionTone(status: string, kind?: string): LedTone {
  if (kind) return 'waiting'
  if (status === 'running') return 'running'
  if (status === 'waiting') return 'waiting'
  if (status === 'done') return 'done'
  return 'muted'
}

/** consecutive failed polls before the page says it can't get the latest */
const STALE_AFTER = 3

function useFailedPolls(errorUpdateCount: number, dataUpdatedAt: number) {
  const [base, setBase] = useState({
    errors: errorUpdateCount,
    data: dataUpdatedAt,
  })
  if (base.data !== dataUpdatedAt)
    setBase({ errors: errorUpdateCount, data: dataUpdatedAt })
  return base.data === dataUpdatedAt ? errorUpdateCount - base.errors : 0
}
export function prefetchSession(client: QueryClient, id: string) {
  void client.prefetchQuery({
    queryKey: detailKey(id),
    queryFn: () => readDetail(client, id),
    staleTime: 10_000,
  })
}
/**
 * The chat half of the diagnostics snapshot: scroll state, the loaded window
 * and the newest user messages the page holds — client-trace's renderedChat
 * says which of them it actually drew.
 */
const chatDiag = (
  follow: { pinned: boolean; unread: number },
  messages: Array<Message>,
  start: number,
  total: number,
) => ({
  pinned: follow.pinned,
  unread: follow.unread,
  shown: messages.length,
  total,
  start,
  loadedUsers: messages
    .map((m, i) => ({ at: start + i, role: m.role, text: m.text }))
    .filter((m) => m.role === 'user')
    .slice(-15)
    .map((m) => ({ at: m.at, text: m.text.slice(0, 40) })),
})

/** absolute index just past the newest message the page has */
const transcriptEnd = (data?: Detail) =>
  (data?.start ?? 0) + (data?.messages?.length ?? 0)

function useComposerBlock(data: Detail | undefined, approved: boolean) {
  const { t } = useLingui()
  return !approved
    ? t`This device is not approved yet (Settings › Device access).`
    : data?.waiting_kind &&
        !data.elicitation?.questions.length &&
        !data.plan?.awaiting_approval
      ? t`The agent is asking for a confirmation: answer it with the keys above.`
      : ''
}

function useLeaveMissingSession(id: string, gone: boolean) {
  const { locale } = useLocale()
  const navigate = useNavigate()
  const client = useQueryClient()
  useEffect(() => {
    if (!gone) return
    // Evict the missing id from both the cached session list and last-opened
    // storage before leaving: otherwise wide-split usePickDefault immediately
    // navigates right back to the same dead id, trapping the main thread in an
    // infinite replaceState loop (scrolling keeps working on the compositor
    // while every click and relay reconnect hangs, 2026-11-27).
    markSessionMissing(id)
    forgetOpened(LAST_SESSION_KEY, id)
    client.setQueryData<SessionsReply>(
      ['remote', 'sessions'],
      (data) => data && hideDeletedSessions(data, new Set([id])),
    )
    void client.invalidateQueries({ queryKey: ['remote', 'sessions'] })
    trace('session-missing-leave', { id })
    void navigate({
      to: '/{-$locale}/console/sessions',
      params: { locale: locale === 'en' ? undefined : locale },
      replace: true,
    })
  }, [gone, id, client, locale, navigate])
}

function draftQuote(composer: Composer, text: string) {
  composer.setText((current) =>
    current.trim() ? `${current.trimEnd()}\n${text}` : text,
  )
  setTimeout(() => document.getElementById('session-composer')?.focus(), 200)
}

function renameSession(
  send: (message: Outgoing) => Promise<boolean>,
  title: string,
) {
  void send({ text: `/rename ${title}`, attachments: [], note: 'rename' })
}

const formatStaleAt = (ms: number) =>
  ms
    ? new Date(ms).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : '—'

function useSentToTicketSheet(sessionId: string) {
  const { t } = useLingui()
  const [seed, setSeed] = useState<{
    round: number
    payload: MessagePayload
  } | null>(null)
  const [open, setOpen] = useState(false)
  const openWith = (payload: MessagePayload) => {
    setSeed((prev) => ({ round: (prev?.round ?? 0) + 1, payload }))
    setOpen(true)
  }
  const sheet = seed ? (
    <QuickTicketSheet
      key={seed.round}
      open={open}
      onOpenChange={setOpen}
      title={t`Turn message into ticket`}
      testId="sent-to-ticket-sheet"
      sessionId={sessionId}
      initialPayload={seed.payload}
      draftKey={`sent-to-ticket:${sessionId}`}
    />
  ) : null
  return { openWith, sheet }
}

function usePendingCallbacks({
  readOnly,
  canSendNow,
  composer,
  dismiss,
  openTicket,
}: {
  readOnly: boolean
  canSendNow: boolean
  composer: Composer
  dismiss: (item: {
    text: string
    attachments?: Array<string>
    at: number
    sentId?: string
    clientOp?: string
  }) => void
  openTicket: (payload: MessagePayload) => void
}) {
  const { t } = useLingui()
  const editPending = !readOnly
    ? (item: {
        text: string
        attachments?: Array<string>
        at: number
        sentId?: string
        clientOp?: string
      }) => {
        composer.replacePayload({
          text: item.text,
          attachments: item.attachments ?? [],
        })
        dismiss(item)
        toast(t`Loaded back into input`)
      }
    : undefined
  const ticketPending = canSendNow
    ? (item: { text: string; attachments?: Array<string> }) =>
        openTicket({
          text: item.text,
          attachments: item.attachments ?? [],
        })
    : undefined
  return { editPending, ticketPending }
}

function useSentHistoryWiring({
  id,
  canSendNow,
  composer,
  send,
  openTicket,
}: {
  id: string
  canSendNow: boolean
  composer: Composer
  send: (message: Outgoing) => Promise<boolean>
  openTicket: (payload: MessagePayload) => void
}) {
  const { t } = useLingui()
  return useSentHistoryControl({
    session: id,
    writable: canSendNow,
    onFill: (p) =>
      composer.text.trim() || composer.images.length
        ? composer.appendPayload(p)
        : composer.replacePayload(p),
    onReplace: composer.replacePayload,
    onResend: canSendNow
      ? (p) => {
          const count = p.attachments.length
          return send({ ...p, note: count ? t`${count} images` : '' })
        }
      : undefined,
    onCreateTicket: canSendNow ? openTicket : undefined,
  })
}

export function SessionDetail({ id }: { id: string }) {
  const { locale } = useLocale()
  const device = useDeviceState()
  const [visibleUsage, setVisibleUsage] = useState('')
  const { detail, data, rawData, pagingIn, loadEarlier } = useSessionDetail(
    id,
    isBusy,
  )
  const writes = useSessionWrites(id, transcriptEnd(rawData), rawData)
  const {
    sending,
    error,
    setError,
    retryIn,
    pendingRaw,
    send,
    run,
    resolvePrompt,
    dismiss,
  } = writes
  const mergedPending = mergeOutboxPending(pendingRaw, data?.outbox)
  useFollowReplacement(data?.replaced_by)
  const end = useRef<HTMLDivElement>(null)
  const messages: Array<Message> = data?.messages ?? []
  const busy = Boolean(data && isBusy(data))
  const readOnly = data?.read_only === true
  const pending = settle(mergedPending, messages, data?.start ?? 0, busy)
  const unconfirmedCount = pending.filter((p) => p.state === 'lost').length
  const failedCount = pending.filter((p) => p.state === 'failed').length
  const unsettledCount = unconfirmedCount + failedCount
  const start = data?.start ?? 0
  const syncing = detail.isFetching && !detail.isFetchedAfterMount
  const follow = useChatScroll(
    end,
    (data ? 1 : 0) + start + messages.length + pending.length + (busy ? 1 : 0),
    landingPolicy({
      status: data?.status,
      pendingCount: pending.length,
      hasPrompt: hasPromptPanel(data),
    }),
    syncing,
  )
  const staleAt = formatStaleAt(detail.dataUpdatedAt)
  const total = data?.total ?? messages.length
  const shown = messages.length
  const compactedAt = data?.compacted_at
  const atCompaction =
    compactedAt !== undefined && start <= compactedAt && start > 0
  const paging = useSessionPaging({
    id,
    end,
    start,
    compactedAt,
    atCompaction,
    hasUserMessage: messages.some((m) => m.role === 'user'),
    pagingIn,
    syncing,
    loadEarlier,
    onManualError: setError,
  })
  useWhileShown(id, data, !readOnly && device.state === 'approved')
  const failed = useFailedPolls(detail.errorUpdateCount, detail.dataUpdatedAt)
  const back = useGoBack({
    to: '/{-$locale}/console/sessions',
    params: { locale: locale === 'en' ? undefined : locale },
  })
  const gone = detail.isError && isMissingSessionError(detail.error)
  useEffect(() => {
    if (data && !gone) clearSessionMissing(id)
  }, [data, gone, id])
  useLeaveMissingSession(id, gone)
  const blocked = useComposerBlock(data, device.state === 'approved')
  const resume = useResumeSheet(id, send, data?.agent)
  const composer = useComposer({
    id,
    onSend: resume.onSend,
    diagnostics: () => ({
      session: { id, agent: data?.agent, status: data?.status, busy },
      chat: chatDiag(follow, messages, start, total),
    }),
  })
  const canSendNow = !readOnly && device.state === 'approved' && !blocked
  const sentToTicket = useSentToTicketSheet(id)
  const sentHistory = useSentHistoryWiring({
    id,
    canSendNow,
    composer,
    send,
    openTicket: sentToTicket.openWith,
  })
  const { editPending, ticketPending } = usePendingCallbacks({
    readOnly,
    canSendNow,
    composer,
    dismiss,
    openTicket: sentToTicket.openWith,
  })
  const wide = useIsWidePhoneFirst()
  return (
    <HostFileProvider
      sessionId={id}
      onQuote={!readOnly ? (text) => draftQuote(composer, text) : undefined}
    >
      <div className="grid flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto] gap-3 md:h-full md:min-h-0 md:gap-0 md:overflow-hidden">
        <SessionHeader
          id={id}
          data={data}
          visibleUsage={visibleUsage}
          onBack={back}
          renameDisabled={readOnly || sending || device.state !== 'approved'}
          canWrite={!readOnly && !sending && device.state === 'approved'}
          onRun={run}
          onNewConversation={() =>
            send({ text: '/new', attachments: [], note: '' })
          }
          onTicketUse={
            !readOnly ? (payload) => composer.appendPayload(payload) : undefined
          }
          onRename={(title) => renameSession(send, title)}
        />

        <SessionThreadBody
          id={id}
          wide={wide}
          data={data}
          detailError={detail.isError ? detail.error : null}
          messages={messages}
          pending={pending}
          mergedPending={mergedPending}
          start={start}
          total={total}
          shown={shown}
          busy={busy}
          syncing={syncing}
          readOnly={readOnly}
          sending={sending}
          approved={device.state === 'approved'}
          end={end}
          followPinned={follow.pinned}
          pagingIn={pagingIn}
          atCompaction={atCompaction}
          autoFailed={paging.autoFailed}
          onLoadManual={paging.loadManual}
          pendingProps={writes.pendingProps(
            canSendNow,
            editPending,
            ticketPending,
          )}
          onRun={run}
          onResolvePrompt={resolvePrompt}
        />

        <form
          className="sticky bottom-0 z-20 -mx-2.5 -mb-4 grid grid-cols-[minmax(0,1fr)] gap-1.5 border-t border-brand-edge bg-brand-deck px-2.5 pt-2 pb-[max(calc(env(safe-area-inset-bottom)+0.25rem),0.75rem)] shadow-[0_-12px_24px_-16px_rgb(0_0_0/0.22)] md:relative md:z-20 md:mx-0 md:mb-0 md:shrink-0 md:gap-2 md:px-[var(--page-x)] md:pt-2 md:pb-4 md:shadow-none"
          onSubmit={(event) => {
            event.preventDefault()
            if (readOnly) return
            setError('')
            if (composer.ready) follow.jump()
            composer
              .submit()
              .catch((e: unknown) => setError((e as Error).message))
          }}
        >
          <JumpLatest
            pinned={follow.pinned}
            unread={follow.unread}
            onJump={follow.jump}
          />
          <OutboxNotice
            unconfirmed={unconfirmedCount}
            failed={failedCount}
            onOpen={() => sentHistory.openSheet(true)}
          />
          <SessionComposerNotices
            stale={failed >= STALE_AFTER || detail.fetchStatus === 'paused'}
            staleAt={staleAt}
            detailError={detail.error}
            data={data}
            retryIn={retryIn}
            readOnly={readOnly}
            error={error}
            blocked={blocked}
            deviceState={device.state}
            locale={locale}
            recovering={sending}
            onRecover={() => void run('session.restart', { recover: true })}
          />
          {!readOnly ? (
            <ComposerBox
              composer={composer}
              blocked={sending || Boolean(blocked)}
              keysDisabled={sending || device.state !== 'approved'}
              writable={device.state === 'approved'}
              onRun={run}
              onNewConversation={() =>
                send({ text: '/new', attachments: [], note: '' })
              }
              onOpenSentHistory={() => sentHistory.openSheet(false)}
              onRecallLatest={sentHistory.recallLatest}
              unsettledCount={unsettledCount}
              commands={
                data?.agent === 'claude' || data?.agent === 'agy'
                  ? {
                      send: (text) =>
                        void send({ text, attachments: [], note: '' }),
                      resume: resume.open,
                    }
                  : undefined
              }
              session={data}
            />
          ) : null}
          <SessionStatusBar data={data} onVisibleUsage={setVisibleUsage} />
          {!readOnly && resume.element}
          {sentHistory.sheet}
          {sentToTicket.sheet}
        </form>
      </div>
    </HostFileProvider>
  )
}
