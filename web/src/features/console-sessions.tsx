// 会话: every live agent session on the host (from attention.json via the
// relay), its conversation, and — with an approved device key — a composer
// that pastes into the session's own tmux TUI. Guards live on the host
// (remote_session.go); the page explains them before the user hits them.
import { useLingui } from '@lingui/react/macro'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowDown } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { Led } from '#/components/deck/led'
import type { LedTone } from '#/components/deck/led'
import { useLocale } from '#/lib/locale-context'
import { useGoBack } from '#/lib/go-back'
import { hostRead } from '#/lib/runtime-client'
import { PAGE, mergeReply, pollArgs } from '#/lib/session-cache'
import { useScreenWakeLock } from '#/lib/wake-lock'
import { useDeviceState } from './device-state'
import { SessionHeader } from './session-header'
import { useChatScroll } from './chat-scroll'
import { ChatThread, SendQueue, settle } from './chat-thread'
import { SessionSubagents } from './session-subagents'
import type { Subagent } from './session-subagents'
import { StickyPrompt } from './chat-sticky'
import { ComposerBox, ErrorLine, useComposer } from './session-composer'
import { PromptPanels } from './session-elicitation'
import type { Elicitation } from './session-elicitation'
import { useSessionWrites } from './session-send'
import type { Message } from './chat-thread'
import { Button } from '#/components/ui/button'

export type SessionCard = {
  id: string
  agent: string
  name: string
  /** Auto or /rename title from Claude aiTitle / Grok summary. */
  title?: string
  window: string
  cwd: string
  branch: string
  status: string
  waiting_kind?: string
  last_prompt: string
  ts: number
  transcript: boolean
  desk_idle_s: number
  running_kind?: string
  background?: Array<BgTask>
  /** Repo family label (git main checkout basename). */
  repo?: string
  /** repo through WEZDECK_REPO_ALIASES, as on the desk (wezterm-config → wezdeck) */
  repo_label?: string
  /** Absolute path of the git main checkout when known. */
  repo_root?: string
  /** Absolute path of this worktree (grouping key with repo_root). */
  worktree?: string
  tmux_session?: string
  tmux_pane?: string
  pane_index?: number
  /** primary | secondary when mounted in tmux; absent for future ticket agents. */
  pane_role?: string
  /** last visit to this worktree at the desk (ms, access ledger behind Alt+g) */
  visited?: number
}

/** waiting on a human: a permission / question prompt, or the turn asked you */
export const needsYou = (row: { status: string; waiting_kind?: string }) =>
  Boolean(row.waiting_kind) || row.status === 'waiting'

/** Last prompt the user typed; harness-injected ones (<task-notification>…) are not. */
export const humanPrompt = (prompt?: string) =>
  prompt && !prompt.trim().startsWith('<') ? prompt : ''

export type BgTask = { id: string; type: string; summary: string }

/** Mid-turn. A session that only waits on background tasks takes input. */
export const isBusy = (row: { status: string; running_kind?: string }) =>
  row.status === 'running' && row.running_kind !== 'background'

export type Usage = {
  model?: string
  context: number
  context_limit: number
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

export type Detail = {
  id: string
  name?: string
  title?: string
  window?: string
  branch?: string
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
      className="key-press chat-in absolute -top-12 left-1/2 inline-flex min-h-10 -translate-x-1/2 items-center gap-1.5 rounded-full border border-brand-edge bg-brand-surface px-4 text-[13px] font-medium text-brand-text shadow-[0_8px_24px_rgb(0_0_0/0.22)]"
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

/**
 * A page left in the background stops polling; coming back it refetches at
 * once and says so, instead of silently showing minutes-old messages:
 * syncing while that fetch runs, then "up to date" for two seconds.
 */
function useResumeSync(id: string, fetching: boolean, updatedAt: number) {
  const client = useQueryClient()
  const [state, setState] = useState<'idle' | 'syncing' | 'synced'>('idle')
  const since = useRef(0)
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      since.current = Date.now()
      setState('syncing')
      void client.invalidateQueries({ queryKey: ['remote', 'session', id] })
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [client, id])
  useEffect(() => {
    if (state !== 'syncing' || fetching || updatedAt < since.current) return
    setState('synced')
    const timer = setTimeout(() => setState('idle'), 2_000)
    return () => clearTimeout(timer)
  }, [state, fetching, updatedAt])
  return state
}

function SyncStatus({
  state,
  at,
}: {
  state: 'idle' | 'syncing' | 'synced'
  at: string
}) {
  const { t } = useLingui()
  if (state === 'idle') return null
  return (
    <p
      role="status"
      data-testid="session-sync"
      className="flex items-center gap-1.5 px-1 text-xs text-brand-muted"
    >
      <Led tone={state === 'syncing' ? 'running' : 'done'} size={10} />
      {state === 'syncing'
        ? t`Back on the page, fetching the latest (last ${at})…`
        : t`Up to date, ${at}`}
    </p>
  )
}

/**
 * The conversation, polled — one cache entry per session (lib/session-cache):
 * each poll asks only for the tail it lacks and merges it by index, so a
 * poll is a few KB instead of the whole page, and reopening a session shows
 * the cached conversation at once. 加载更早 fetches just the earlier page.
 * A failed refetch keeps the cached data on screen (same key), with a stale
 * note below.
 */
function useSessionDetail(id: string) {
  const client = useQueryClient()
  const key = ['remote', 'session', id] as const
  const detail = useQuery({
    queryKey: key,
    enabled: typeof window !== 'undefined',
    refetchInterval: (query) =>
      query.state.data && isBusy(query.state.data) ? 1_000 : 2_500,
    queryFn: async () => {
      const reply = (await hostRead(
        'session',
        pollArgs(id, client.getQueryData<Detail>(key)),
      )) as Detail
      // merge into what is there now: an earlier page may have landed meanwhile
      return mergeReply(client.getQueryData<Detail>(key), reply)
    },
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
        limit: count,
      })) as Detail
      client.setQueryData<Detail>(key, (now) => mergeReply(now, reply))
    } finally {
      setPagingIn(false)
    }
  }
  return { detail, data: detail.data, pagingIn, loadEarlier }
}

export function SessionDetail({ id }: { id: string }) {
  const { t } = useLingui()
  const { locale } = useLocale()
  const device = useDeviceState()
  const { detail, data, pagingIn, loadEarlier } = useSessionDetail(id)
  const { sending, error, setError, retryIn, pendingRaw, send, run } =
    useSessionWrites(id)
  const end = useRef<HTMLDivElement>(null)
  const messages: Array<Message> = data?.messages ?? []
  const pending = settle(pendingRaw, messages)
  const busy = Boolean(data && isBusy(data))
  const follow = useChatScroll(
    end,
    messages.length + pending.length + (busy ? 1 : 0),
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
  const sync = useResumeSync(id, detail.isFetching, detail.dataUpdatedAt)
  // the phone often sits on the desk following the agent: keep it awake
  useScreenWakeLock(true)
  const back = useGoBack({
    to: '/{-$locale}/console/sessions',
    params: { locale: locale === 'en' ? undefined : locale },
  })
  const elicitation = data?.elicitation
  const asking = Boolean(elicitation && elicitation.questions.length > 0)
  const planReview = Boolean(data?.plan?.awaiting_approval)
  const blocked =
    device.state !== 'approved'
      ? t`Writing is not enabled on this device yet (Settings › Write access).`
      : data?.waiting_kind && !asking && !planReview
        ? t`The agent is asking for a confirmation: answer it with the keys above.`
        : ''
  const composer = useComposer({
    id,
    onSend: send,
    diagnostics: () => ({
      session: { id, agent: data?.agent, status: data?.status, busy },
      chat: { pinned: follow.pinned, unread: follow.unread, shown, total },
    }),
  })
  return (
    <div className="grid flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto] gap-3">
      <SessionHeader
        id={id}
        data={data}
        onBack={back}
        renameDisabled={sending || device.state !== 'approved'}
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
            className="rounded-[12px] bg-brand-waiting/10 px-3 py-2 text-sm"
          >
            {String(detail.error.message)}
          </p>
        ) : null}
        {messages.length || pending.length ? (
          <>
            <StickyPrompt end={end} messages={messages} start={start} />
            {total > 0 ? (
              <div className="flex items-center justify-between gap-2 px-1 text-[12px] text-brand-label">
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
              activity={
                busy
                  ? {
                      since: data?.turn_started,
                      compactSince: data?.compact_started,
                      tokens: data?.turn_output,
                    }
                  : undefined
              }
              sessionId={id}
            />
          </>
        ) : data?.screen ? (
          <pre className="overflow-x-auto rounded-[14px] bg-brand-surface p-3 font-mono text-[12px] leading-snug">
            {data.screen}
          </pre>
        ) : null}
        <PromptPanels
          data={data}
          sending={sending}
          canWrite={device.state === 'approved'}
          onKey={(key) => run('key', { key })}
        />
        <div ref={end} />
      </div>

      <form
        className="sticky bottom-0 -mx-2.5 -mb-4 grid grid-cols-[minmax(0,1fr)] gap-1.5 border-t border-brand-edge bg-brand-deck px-2.5 pt-2 pb-[max(env(safe-area-inset-bottom),0.5rem)] shadow-[0_-12px_24px_-16px_rgb(0_0_0/0.22)]"
        onSubmit={(event) => {
          event.preventDefault()
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
        {detail.isError ? null : <SyncStatus state={sync} at={staleAt} />}
        {(detail.isError || detail.fetchStatus === 'paused') && data ? (
          <p
            role="status"
            data-testid="session-stale"
            className="rounded-[10px] bg-brand-waiting/10 px-3 py-1.5 text-xs text-brand-text"
          >
            {t`Can't get the latest from the host, showing ${staleAt}:`}{' '}
            {detail.error?.message ?? t`this device is offline`}
          </p>
        ) : null}
        <SessionSubagents agents={data?.subagents} />
        <SendQueue pending={pending} busy={busy} />
        {retryIn ? (
          <p role="status" className="text-xs text-brand-muted">
            {t`Someone just used the desk; sending in ${retryIn}s…`}
          </p>
        ) : error ? (
          <ErrorLine message={error} />
        ) : blocked ? (
          <p className="text-xs text-brand-muted">
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
        <ComposerBox
          composer={composer}
          blocked={sending || Boolean(blocked)}
          keysDisabled={sending || device.state !== 'approved'}
          writable={device.state === 'approved'}
          onKey={(key) => void run('key', { key })}
        />
      </form>
    </div>
  )
}
