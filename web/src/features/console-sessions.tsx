// 会话: every live agent session on the host (from attention.json via the
// relay), its conversation, and — with an approved device key — a composer
// that pastes into the session's own tmux TUI. Guards live on the host
// (remote_session.go); the page explains them before the user hits them.
import { useLingui } from '@lingui/react/macro'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowDown } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'

import type { LedTone } from '#/components/deck/led'
import type { GitStatus } from '#/components/deck/session-tags'
import { useLocale } from '#/lib/locale-context'
import { useGoBack } from '#/lib/go-back'
import { hostRead } from '#/lib/runtime-client'
import { PAGE, mergeReply, pollArgs } from '#/lib/session-cache'
import { useDeviceState } from './device-state'
import { SessionHeader } from './session-header'
import { useChatScroll } from './chat-scroll'
import { useWhileShown } from './session-while-shown'
import { ChatThread, settle } from './chat-thread'
import { SessionSubagents } from './session-subagents'
import type { Subagent } from './session-subagents'
import { StickyPrompt } from './chat-sticky'
import { EmptySession } from './session-empty'
import { ComposerBox, ErrorLine, useComposer } from './session-composer'
import { PromptPanels } from './session-elicitation'
import type { Elicitation } from './session-elicitation'
import { useFollowReplacement, useSessionWrites } from './session-send'
import { useResumeSheet } from './session-commands'
import { SessionStatusBar } from './session-statusbar'
import type { StatusFields } from './session-statusbar'
import type { BgTask } from './session-background'
import type { Message } from './chat-thread'
import { Button } from '#/components/ui/button'
import type { PendingCall } from './session-permission'
import type { SessionCard } from './session-card'

export type { SessionCard }

/** waiting on a human: a permission / question prompt, or the turn asked you */
export const needsYou = (row: { status: string; waiting_kind?: string }) =>
  Boolean(row.waiting_kind) || row.status === 'waiting'

/** Last prompt the user typed; harness-injected ones (<task-notification>…) are not. */
export const humanPrompt = (prompt?: string) =>
  prompt && !prompt.trim().startsWith('<') ? prompt : ''

export type { BgTask }

/** Mid-turn. A session that only waits on background tasks takes input. */
export const isBusy = (row: { status: string; running_kind?: string }) =>
  row.status === 'running' && row.running_kind !== 'background'

export type Usage = {
  model?: string
  context: number
  context_limit: number
  /** compacted since the last reply: `context` is unknown until the next one */
  context_pending?: boolean
  turns: number
  output: number
  input: number
  cache_read: number
}

export type RateWindow = { used_percentage: number; resets_at?: number }

/** the Claude account's limits as Claude Code last reported them (remote_limits.go) */
export type AccountLimits = {
  five_hour?: RateWindow
  seven_day?: RateWindow
  at: number
}

/** What the phone may offer for this agent (host agent_adapter.go agentCaps). */
export type AgentCapabilities = {
  ask_options: boolean
  plan_review: boolean
  usage: 'transcript' | 'token_count' | 'none'
  account_limits: boolean
  mid_turn_input: 'queue' | 'steer'
  title: boolean
}

export type Detail = StatusFields & {
  messages_rev?: number
  read_only?: boolean
  id: string
  name?: string
  title?: string
  window?: string
  branch?: string
  /** working-tree status of the pane's cwd (git_status.go) */
  git?: GitStatus
  usage?: Usage
  account?: AccountLimits
  /** host-built block an agent can act on (remote_reference.go) */
  reference?: string
  capabilities?: AgentCapabilities
  /** everything the host knows, grouped (remote_meta.go) */
  meta?: Array<{ name: string; rows: Array<{ key: string; value: string }> }>
  total?: number
  start?: number
  /** Claude subagents (Agent tool, forked skills) and what they are doing */
  subagents?: Array<Subagent>
  /** index of the latest context-compaction marker; earlier = pre-compaction history */
  compacted_at?: number
  compactions?: number
  agent?: string
  status: string
  /** the attention entry's last change (ms): seen-ack clears this state only */
  ts?: number
  waiting_kind?: string
  running_kind?: string
  background?: Array<BgTask>
  messages?: Array<Message>
  screen?: string
  /** ms: when the running turn began (attention turn_started) */
  turn_started?: number
  /** ms: when the running context compaction began */
  compact_started?: number
  /** output tokens of the running turn (transcript usage) */
  turn_output?: number
  elicitation?: Elicitation
  plan?: { excerpt?: string; awaiting_approval?: boolean }
  /** a permission prompt: the call it is about (host permission.go) */
  permission?: PendingCall
  /** cleared in its pane (/new, /clear): the session that took its place */
  replaced_by?: string
  /** the local Runtime's sessions/focus payload (在终端中打开, session-focus.tsx) */
  focus?: { session_id: string; recent?: boolean; archived_ts?: number }
}

export function sessionTone(status: string, kind?: string): LedTone {
  if (kind) return 'waiting'
  if (status === 'running') return 'running'
  if (status === 'waiting') return 'waiting'
  if (status === 'done') return 'done'
  return 'muted'
}

export function useStatusText() {
  const { t } = useLingui()
  return (status: string, kind?: string, runningKind?: string, bg = 0) =>
    kind
      ? t`waiting for your confirmation`
      : status === 'running' && runningKind === 'background'
        ? t`${bg} background tasks running`
        : status === 'running' && runningKind === 'compacting'
          ? t`compacting the context`
          : status === 'idle'
            ? t({ message: 'Idle', context: 'session status' })
            : status === 'running'
              ? t`working`
              : status === 'waiting'
                ? t`waiting for you`
                : status === 'done'
                  ? t`finished its turn`
                  : status
}

export function useSessions() {
  return useQuery({
    queryKey: ['remote', 'sessions'],
    enabled: typeof window !== 'undefined',
    refetchInterval: 5_000,
    queryFn: async () =>
      (await hostRead('sessions', {})) as {
        sessions: Array<SessionCard>
      },
  })
}

function JumpLatest({
  pinned,
  unread,
  onJump,
}: {
  pinned: boolean
  unread: number
  onJump: () => void
}) {
  const { t } = useLingui()
  if (pinned) return null
  return (
    <Button
      variant="plain"
      type="button"
      onClick={onJump}
      data-testid="jump-latest"
      // a light chip with an edge and a deep shadow, not the dark solid
      // style: it floats over the conversation, and over a user bubble
      // (same dark fill) the solid chip vanished
      className="key-press chat-in absolute -top-12 left-1/2 inline-flex min-h-10 -translate-x-1/2 items-center gap-1.5 rounded-full border border-brand-edge bg-brand-surface px-4 text-caption font-medium text-brand-text shadow-[0_8px_24px_rgb(0_0_0/0.22)]"
    >
      <ArrowDown size={15} aria-hidden />
      {unread > 0 ? t`${unread} new` : t`Latest`}
    </Button>
  )
}

/**
 * Loading earlier messages grows the page above the reader: remember the
 * distance from the bottom before, restore it once the older ones render.
 */
function useKeepPlace(
  end: React.RefObject<HTMLDivElement | null>,
  start: number,
) {
  const fromBottom = useRef<number | null>(null)
  useLayoutEffect(() => {
    const scroller = end.current?.closest('.overflow-y-auto')
    if (!scroller || fromBottom.current === null) return
    scroller.scrollTop = scroller.scrollHeight - fromBottom.current
    fromBottom.current = null
  }, [start, end])
  return () => {
    const scroller = end.current?.closest('.overflow-y-auto')
    if (scroller)
      fromBottom.current = scroller.scrollHeight - scroller.scrollTop
  }
}

/** consecutive failed polls before the page says it can't get the latest */
const STALE_AFTER = 3

/**
 * Polls that failed since the last one that worked (queries don't retry,
 * so each failed poll is one error update). One flaky poll on a phone link
 * is not worth a banner; three in a row are.
 */
function useFailedPolls(errorUpdateCount: number, dataUpdatedAt: number) {
  const [base, setBase] = useState({
    errors: errorUpdateCount,
    data: dataUpdatedAt,
  })
  if (base.data !== dataUpdatedAt)
    setBase({ errors: errorUpdateCount, data: dataUpdatedAt })
  // the render that saw new data: nothing failed since (state catches up)
  return base.data === dataUpdatedAt ? errorUpdateCount - base.errors : 0
}

/**
 * The conversation, polled — one cache entry per session (lib/session-cache):
 * each poll asks only for the tail it lacks and merges it by index, so a
 * poll is a few KB instead of the whole page, and reopening a session shows
 * the cached conversation at once. 加载更早 fetches just the earlier page.
 * A failed refetch keeps the cached data on screen (same key), with a stale
 * note below.
 */
const detailKey = (id: string) => ['remote', 'session', id] as const

/** one poll of a conversation, merged into what the cache holds */
async function readDetail(client: QueryClient, id: string) {
  const key = detailKey(id)
  const reply = (await hostRead(
    'session',
    pollArgs(id, client.getQueryData<Detail>(key)),
  )) as Detail
  // merge into what is there now: an earlier page may have landed meanwhile
  return mergeReply(client.getQueryData<Detail>(key), reply)
}

/**
 * Warm a conversation before it opens (a row hovered, focused or pressed;
 * j / k's neighbours): a session not yet in this browser's cache showed a
 * Loading… frame with the page collapsed to nothing between two sessions.
 */
export function prefetchSession(client: QueryClient, id: string) {
  void client.prefetchQuery({
    queryKey: detailKey(id),
    queryFn: () => readDetail(client, id),
    staleTime: 10_000,
  })
}

function useSessionDetail(id: string) {
  const client = useQueryClient()
  const key = detailKey(id)
  const detail = useQuery({
    queryKey: key,
    enabled: typeof window !== 'undefined',
    refetchInterval: (query) =>
      query.state.data && isBusy(query.state.data) ? 1_000 : 2_500,
    queryFn: () => readDetail(client, id),
  })
  const [pagingIn, setPagingIn] = useState(false)
  const loadEarlier = async (count: number) => {
    const have = client.getQueryData<Detail>(key)
    if (!have || pagingIn) return
    setPagingIn(true)
    try {
      const reply = (await hostRead('session', {
        id,
        before: have.start ?? 0,
        messages_rev: have.messages_rev ?? 0,
        limit: count,
      })) as Detail
      client.setQueryData<Detail>(key, (now) => mergeReply(now, reply))
    } finally {
      setPagingIn(false)
    }
  }
  return { detail, data: detail.data, pagingIn, loadEarlier }
}

/**
 * Claude Code's Ctrl+B (the running foreground command / subagent goes on
 * in the background), offered on the running call's own row when this device writes.
 */
const toBackground = (
  data: Detail | undefined,
  device: string,
  run: (action: 'key', args: Record<string, unknown>) => Promise<boolean>,
) =>
  data?.agent === 'claude' && device === 'approved'
    ? () => void run('key', { key: 'C-b' })
    : undefined

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

/** the running turn's progress from the host's hooks (chat-turn.tsx) */
const activityOf = (data?: Detail) => ({
  since: data?.turn_started,
  compactSince: data?.compact_started,
  tokens: data?.turn_output,
})

/** absolute index just past the newest message the page has */
const transcriptEnd = (data?: Detail) =>
  (data?.start ?? 0) + (data?.messages?.length ?? 0)

function SessionInputUnavailable() {
  const { t } = useLingui()
  return (
    <p role="status" className="text-meta text-brand-label">
      {t`Web sending is unavailable for this session.`}
    </p>
  )
}

export function SessionDetail({ id }: { id: string }) {
  const { t } = useLingui()
  const { locale } = useLocale()
  const device = useDeviceState()
  const { detail, data, pagingIn, loadEarlier } = useSessionDetail(id)
  const writes = useSessionWrites(id, transcriptEnd(detail.data))
  const { sending, error, setError, retryIn, pendingRaw, send, run } = writes
  useFollowReplacement(data?.replaced_by)
  const end = useRef<HTMLDivElement>(null)
  const messages: Array<Message> = data?.messages ?? []
  const busy = Boolean(data && isBusy(data))
  const readOnly = data?.read_only === true
  const pending = settle(pendingRaw, messages, data?.start ?? 0, busy)
  // +1 once the detail has loaded: a new session with no messages yet shows
  // only the pane's screen, and a count of 0 never landed at the bottom
  const follow = useChatScroll(
    end,
    (data ? 1 : 0) + messages.length + pending.length + (busy ? 1 : 0),
  )
  const staleAt = detail.dataUpdatedAt
    ? new Date(detail.dataUpdatedAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : '—'
  const total = data?.total ?? messages.length
  const shown = messages.length
  const start = data?.start ?? 0
  const compactedAt = data?.compacted_at
  // reached the latest compaction marker: what is above is the old context
  const atCompaction =
    compactedAt !== undefined && start <= compactedAt && start > 0
  const keepPlace = useKeepPlace(end, start)
  useWhileShown(id, data, !readOnly && device.state === 'approved')
  const failed = useFailedPolls(detail.errorUpdateCount, detail.dataUpdatedAt)
  const back = useGoBack({
    to: '/{-$locale}/console/sessions',
    params: { locale: locale === 'en' ? undefined : locale },
  })
  const asking = (data?.elicitation?.questions.length ?? 0) > 0
  const planReview = Boolean(data?.plan?.awaiting_approval)
  const blocked =
    device.state !== 'approved'
      ? t`This device is not approved yet (Settings › Device access).`
      : data?.waiting_kind && !asking && !planReview
        ? t`The agent is asking for a confirmation: answer it with the keys above.`
        : ''
  const resume = useResumeSheet(id, send, data?.agent)
  const composer = useComposer({
    id,
    onSend: resume.onSend,
    diagnostics: () => ({
      session: { id, agent: data?.agent, status: data?.status, busy },
      chat: chatDiag(follow, messages, start, total),
    }),
  })
  return (
    <div className="grid flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto] gap-3">
      <SessionHeader
        id={id}
        data={data}
        onBack={back}
        renameDisabled={readOnly || sending || device.state !== 'approved'}
        onRename={(title) =>
          void send({
            text: `/rename ${title}`,
            attachments: [],
            note: 'rename',
          })
        }
      />

      <div
        className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-end gap-2"
        aria-live="polite"
      >
        {detail.isError && !data ? (
          <p
            role="status"
            className="rounded-xl bg-brand-waiting/10 px-3 py-2 text-body"
          >
            {String(detail.error.message)}
          </p>
        ) : null}
        {messages.length || pending.length ? (
          <>
            <StickyPrompt
              end={end}
              messages={messages}
              start={start}
              following={follow.pinned}
            />
            {total > 0 ? (
              <div className="flex items-center justify-between gap-2 px-1 text-meta text-brand-label">
                <span>{t`${total} messages, showing ${shown}`}</span>
                {start > 0 ? (
                  <Button
                    variant="plain"
                    type="button"
                    disabled={pagingIn}
                    onClick={() => {
                      keepPlace()
                      // page back to the compaction marker first; past it only on request
                      const count =
                        atCompaction || compactedAt === undefined
                          ? PAGE
                          : Math.min(PAGE, start - compactedAt)
                      loadEarlier(count).catch((e: unknown) => {
                        setError((e as Error).message)
                      })
                    }}
                    className="min-h-9 rounded-full bg-brand-surface px-3 text-brand-text"
                  >
                    {pagingIn
                      ? t`Loading…`
                      : atCompaction
                        ? t`Show history before compaction`
                        : t`Load earlier`}
                  </Button>
                ) : null}
              </div>
            ) : null}
            <ChatThread
              messages={messages}
              start={start}
              busy={busy}
              activity={busy ? activityOf(data) : undefined}
              {...writes.pendingProps(
                !readOnly && device.state === 'approved' && !blocked,
              )}
              status={data?.status}
              statusTs={data?.ts}
              onBackground={toBackground(data, device.state, run)}
              sessionId={id}
            />
          </>
        ) : data ? (
          <EmptySession data={data} />
        ) : null}
        <PromptPanels
          data={data}
          sending={sending}
          canWrite={!readOnly && device.state === 'approved'}
          onKey={(key) => run('key', { key })}
        />
        <div ref={end} />
      </div>

      <form
        className="sticky bottom-0 -mx-2.5 -mb-4 grid grid-cols-[minmax(0,1fr)] gap-1.5 border-t border-brand-edge bg-brand-deck px-2.5 pt-2 pb-[max(calc(env(safe-area-inset-bottom)+0.25rem),0.75rem)] shadow-[0_-12px_24px_-16px_rgb(0_0_0/0.22)]"
        onSubmit={(event) => {
          event.preventDefault()
          if (readOnly) return
          setError('')
          composer.submit().catch((e: unknown) => {
            setError((e as Error).message)
          })
        }}
      >
        <JumpLatest
          pinned={follow.pinned}
          unread={follow.unread}
          onJump={follow.jump}
        />
        {(failed >= STALE_AFTER || detail.fetchStatus === 'paused') && data ? (
          <p
            role="status"
            data-testid="session-stale"
            className="rounded-xl bg-brand-waiting/10 px-3 py-1.5 text-meta text-brand-text"
          >
            {t`Can't get the latest from the host, showing ${staleAt}:`}{' '}
            {detail.error?.message ?? t`this device is offline`}
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
            {device.state !== 'approved' ? (
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
        {readOnly ? (
          <SessionInputUnavailable />
        ) : (
          <ComposerBox
            composer={composer}
            blocked={sending || Boolean(blocked)}
            keysDisabled={sending || device.state !== 'approved'}
            writable={device.state === 'approved'}
            onRun={run}
            commands={
              data?.agent === 'claude'
                ? {
                    send: (text) =>
                      void send({ text, attachments: [], note: '' }),
                    resume: resume.open,
                  }
                : undefined
            }
            session={data}
          />
        )}
        <SessionStatusBar data={data} />
        {!readOnly && resume.element}
      </form>
    </div>
  )
}
