// 会话: every live agent session on the host (from attention.json via the
// relay), its conversation, and — with an approved device key — a composer
// that pastes into the session's own tmux TUI. Guards live on the host
// (remote_session.go); the page explains them before the user hits them.
import { useLingui } from '@lingui/react/macro'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams, useRouter } from '@tanstack/react-router'
import { ArrowDown } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { Led } from '#/components/deck/led'
import type { LedTone } from '#/components/deck/led'
import { useLocale } from '#/lib/locale-context'
import { remoteLink } from '#/lib/remote-link'
import { useDeviceState } from './device-state'
import { SessionHeader } from './session-header'
import { useChatScroll } from './chat-scroll'
import { ChatThread, SendQueue, settle } from './chat-thread'
import { StickyPrompt } from './chat-sticky'
import { ComposerBox, ErrorLine, useComposer } from './session-composer'
import {
  pickElicitationOption,
  SessionElicitation,
  SessionPermissionKeys,
  SessionPlanReview,
} from './session-elicitation'
import type { Elicitation } from './session-elicitation'
import { SessionList } from './session-list'
import { useSessionWrites } from './session-send'
import type { Message } from './chat-thread'

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
  /** Absolute path of the git main checkout when known. */
  repo_root?: string
  /** Absolute path of this worktree (grouping key with repo_root). */
  worktree?: string
  tmux_session?: string
  tmux_pane?: string
  pane_index?: number
  /** primary | secondary when mounted in tmux; absent for future ticket agents. */
  pane_role?: string
}

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

export type Detail = {
  id: string
  name?: string
  title?: string
  window?: string
  branch?: string
  usage?: Usage
  account?: AccountLimits
  total?: number
  start?: number
  agent?: string
  status: string
  waiting_kind?: string
  running_kind?: string
  background?: Array<BgTask>
  messages?: Array<Message>
  screen?: string
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
        ? t`turn finished, ${bg} background tasks running; you can send`
        : status === 'idle'
          ? t`idle, you can send`
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
      (await remoteLink.rpc('sessions', {})) as {
        sessions: Array<SessionCard>
      },
  })
}

export function ConsoleSessionsPage() {
  const { id } = useParams({ strict: false })
  return id ? <SessionDetail id={id} /> : <SessionList />
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
    <button
      type="button"
      onClick={onJump}
      data-testid="jump-latest"
      className="chat-in absolute -top-12 left-1/2 inline-flex min-h-10 -translate-x-1/2 items-center gap-1.5 rounded-full bg-brand-text px-4 text-[13px] font-medium text-brand-deck shadow-lg"
    >
      <ArrowDown size={15} aria-hidden />
      {unread > 0 ? t`${unread} new` : t`Latest`}
    </button>
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

function SessionDetail({ id }: { id: string }) {
  const { t } = useLingui()
  const router = useRouter()
  const navigate = useNavigate()
  const { locale } = useLocale()
  const device = useDeviceState()
  const [limit, setLimit] = useState(60)
  const detail = useQuery({
    queryKey: ['remote', 'session', id, limit],
    placeholderData: (previous) => previous,
    enabled: typeof window !== 'undefined',
    refetchInterval: (query) =>
      query.state.data && isBusy(query.state.data) ? 1_000 : 2_500,
    queryFn: async () =>
      (await remoteLink.rpc('session', { id, limit })) as Detail,
  })
  const { sending, error, setError, retryIn, pendingRaw, send, run } =
    useSessionWrites(id)
  const end = useRef<HTMLDivElement>(null)
  const data = detail.data
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
  const keepPlace = useKeepPlace(end, start)
  const sync = useResumeSync(id, detail.isFetching, detail.dataUpdatedAt)
  const back = () => {
    if (window.history.length > 1) router.history.back()
    else
      void navigate({
        to: '/{-$locale}/console/sessions',
        params: { locale: locale === 'en' ? undefined : locale },
      })
  }
  const elicitation = data?.elicitation
  const asking = Boolean(elicitation && elicitation.questions.length > 0)
  const planReview = Boolean(data?.plan?.awaiting_approval)
  const blocked =
    device.state !== 'approved'
      ? t`Writing is not enabled on this phone yet (Settings › Phone writing).`
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
                  <button
                    type="button"
                    onClick={() => {
                      keepPlace()
                      setLimit((n) => n + 60)
                    }}
                    className="min-h-9 rounded-full bg-brand-surface px-3 text-brand-text"
                  >
                    {detail.isFetching ? t`Loading…` : t`Load earlier`}
                  </button>
                ) : null}
              </div>
            ) : null}
            <ChatThread messages={messages} start={start} busy={busy} />
          </>
        ) : data?.screen ? (
          <pre className="overflow-x-auto rounded-[14px] bg-brand-surface p-3 font-mono text-[12px] leading-snug">
            {data.screen}
          </pre>
        ) : null}
        {asking && elicitation ? (
          <SessionElicitation
            elicitation={elicitation}
            disabled={sending || device.state !== 'approved'}
            onKey={(key) => void run('key', { key })}
            onPick={(_qi, oi) =>
              void (async () => {
                await pickElicitationOption(oi, (key) => run('key', { key }))
              })()
            }
          />
        ) : null}
        {!asking && (data?.plan?.excerpt || planReview) ? (
          <SessionPlanReview
            excerpt={data?.plan?.excerpt}
            awaitingApproval={planReview}
            disabled={sending || device.state !== 'approved'}
            onKey={(key) => void run('key', { key })}
          />
        ) : null}
        {data?.waiting_kind && !asking && !planReview ? (
          <SessionPermissionKeys
            screen={data.screen}
            disabled={sending || device.state !== 'approved'}
            onKey={(key) => void run('key', { key })}
          />
        ) : null}
        <div ref={end} />
      </div>

      <form
        className="sticky bottom-0 -mx-2.5 -mb-4 grid gap-1.5 border-t border-brand-edge bg-brand-deck px-2.5 pt-2 pb-[max(env(safe-area-inset-bottom),0.5rem)] shadow-[0_-12px_24px_-16px_rgb(0_0_0/0.22)]"
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
                to="/{-$locale}/console/me"
                params={{ locale: locale === 'en' ? undefined : locale }}
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
