// Presentational sub-sections of SessionDetail, kept separate so
// console-sessions.tsx stays focused on state wiring.
import { useLingui } from '@lingui/react/macro'
import { Link } from '@tanstack/react-router'
import type { RefObject } from 'react'

import { ThreadPagingBar } from './chat-controls'
import { StickyPrompt } from './chat-sticky'
import { ChatThread } from './chat-thread'
import type { Message } from './chat-thread'
import { ErrorLine } from './session-composer'
import type { Detail } from './session-detail-types'
import { PromptPanels } from './session-elicitation'
import { EmptySession } from './session-empty'
import type { mergeOutboxPending, useSessionWrites } from './session-send'
import { SessionSubagents } from './session-subagents'

const activityOf = (data?: Detail) => ({
  since: data?.turn_started,
  compactSince: data?.compact_started,
  tokens: data?.turn_output,
  rate: data?.token_rate?.tok_per_s,
})

const toBackground = (
  data: Detail | undefined,
  approved: boolean,
  run: (action: 'key', args: Record<string, unknown>) => Promise<boolean>,
) =>
  data?.agent === 'claude' && approved
    ? () => void run('key', { key: 'C-b' })
    : undefined

export function SessionComposerNotices({
  stale,
  staleAt,
  detailError,
  data,
  retryIn,
  readOnly,
  error,
  blocked,
  deviceState,
  locale,
}: {
  stale: boolean
  staleAt: string
  detailError: Error | null
  data: Detail | undefined
  retryIn: number
  readOnly: boolean
  error: string
  blocked: string
  deviceState: string
  locale: 'en' | 'zh'
}) {
  const { t } = useLingui()
  return (
    <>
      {stale && data ? (
        <p
          role="status"
          data-testid="session-stale"
          className="rounded-xl bg-brand-waiting/10 px-3 py-1.5 text-meta text-brand-text"
        >
          {t`Can't get the latest from the host, showing ${staleAt}:`}{' '}
          {detailError?.message ?? t`this device is offline`}
        </p>
      ) : null}
      <SessionSubagents agents={data?.subagents} />
      {retryIn && !readOnly ? (
        <p role="status" className="text-meta text-brand-muted">
          {t`Someone just used the desk; sending in ${retryIn}s…`}
        </p>
      ) : error ? (
        <ErrorLine message={error} />
      ) : blocked && !readOnly ? (
        <p className="text-meta text-brand-muted">
          {blocked}{' '}
          {deviceState !== 'approved' ? (
            <Link
              to="/{-$locale}/console/me/$page"
              params={{
                locale: locale === 'en' ? undefined : locale,
                page: 'writing',
              }}
              className="text-brand-running"
            >
              {t`Open settings`}
            </Link>
          ) : null}
        </p>
      ) : null}
    </>
  )
}

export function SessionThreadBody({
  id,
  data,
  detailError,
  messages,
  pending,
  mergedPending,
  start,
  total,
  shown,
  busy,
  syncing,
  readOnly,
  sending,
  approved,
  end,
  followPinned,
  pagingIn,
  atCompaction,
  autoFailed,
  onLoadManual,
  pendingProps,
  onRun,
}: {
  id: string
  data: Detail | undefined
  detailError: Error | null
  messages: Array<Message>
  pending: Array<unknown>
  mergedPending: ReturnType<typeof mergeOutboxPending>
  start: number
  total: number
  shown: number
  busy: boolean
  syncing: boolean
  readOnly: boolean
  sending: boolean
  approved: boolean
  end: RefObject<HTMLDivElement | null>
  followPinned: boolean
  pagingIn: boolean
  atCompaction: boolean
  autoFailed: boolean
  onLoadManual: () => void
  pendingProps: ReturnType<ReturnType<typeof useSessionWrites>['pendingProps']>
  onRun: (
    action: 'key' | 'session.restart',
    args: Record<string, unknown>,
  ) => Promise<boolean>
}) {
  return (
    <div
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-end gap-2"
      aria-live="polite"
    >
      {detailError && !data ? (
        <p
          role="status"
          className="rounded-xl bg-brand-waiting/10 px-3 py-2 text-body"
        >
          {String(detailError.message)}
        </p>
      ) : null}
      {messages.length || pending.length ? (
        <>
          <StickyPrompt
            end={end}
            messages={messages}
            start={start}
            following={followPinned}
          />
          <ThreadPagingBar
            total={total}
            shown={shown}
            start={start}
            pagingIn={pagingIn}
            atCompaction={atCompaction}
            autoFailed={autoFailed}
            onLoadEarlier={onLoadManual}
          />
          <ChatThread
            messages={messages}
            start={start}
            busy={busy}
            activity={busy ? activityOf(data) : undefined}
            {...pendingProps}
            pending={mergedPending}
            status={data?.status}
            statusTs={data?.ts}
            onBackground={toBackground(data, approved, onRun)}
            sessionId={id}
            syncing={syncing}
          />
        </>
      ) : data ? (
        <EmptySession data={data} />
      ) : null}
      <PromptPanels
        data={data}
        sending={sending}
        canWrite={!readOnly && approved}
        onKey={(key) => onRun('key', { key })}
      />
      <div ref={end} />
    </div>
  )
}
