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
import { useAgo } from './tickets-view'
import { SessionHeader } from './session-header'
import { useChatScroll } from './chat-scroll'
import { ChatThread, SendQueue, settle } from './chat-thread'
import { ComposerBox, useComposer } from './session-composer'
import type { Outgoing } from './session-composer'
import type { Message, Pending } from './chat-thread'

export type SessionCard = {
  id: string
  agent: string
  name: string
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

export type Detail = {
  id: string
  usage?: Usage
  total?: number
  start?: number
  agent?: string
  status: string
  waiting_kind?: string
  running_kind?: string
  background?: Array<BgTask>
  messages?: Array<Message>
  screen?: string
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

const ts = (iso?: number) => (iso ? new Date(iso).toISOString() : undefined)

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

function SessionList() {
  const { t } = useLingui()
  const { locale } = useLocale()
  const localeParam = locale === 'en' ? undefined : locale
  const sessions = useSessions()
  const ago = useAgo()
  const statusText = useStatusText()
  const rows = sessions.data?.sessions ?? []
  return (
    <div className="grid max-w-2xl content-start gap-3">
      <h1 className="hidden text-base font-semibold md:block">
        {t({ message: 'Sessions', context: 'nav' })}
      </h1>
      <p className="text-sm text-brand-muted">
        {t`Agents running in tmux on the host. Open one to read it and talk to it.`}
      </p>
      {sessions.isError ? (
        <p
          role="status"
          className="rounded-[12px] bg-brand-waiting/10 px-3 py-2 text-sm"
        >
          {String(sessions.error.message)}
        </p>
      ) : null}
      {rows.length === 0 && !sessions.isError ? (
        <p className="rounded-[14px] bg-brand-surface px-4 py-10 text-center text-sm text-brand-muted">
          {sessions.isPending ? t`Loading…` : t`No agent sessions are running.`}
        </p>
      ) : (
        <ul
          aria-label={t`Agent sessions`}
          className="overflow-hidden rounded-[16px] bg-brand-surface"
        >
          {rows.map((row) => (
            <li
              key={row.id}
              className="border-b border-brand-edge last:border-b-0"
            >
              <Link
                to="/{-$locale}/console/sessions/$id"
                params={{ locale: localeParam, id: row.id }}
                data-session={row.id}
                className="key-press flex min-h-16 items-start gap-3 px-4 py-3"
              >
                <span className="pt-1.5">
                  <Led
                    tone={sessionTone(row.status, row.waiting_kind)}
                    size={12}
                  />
                </span>
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[16px] font-semibold">
                      {row.name || row.window || row.id.slice(0, 8)}
                    </span>
                    <span className="shrink-0 text-xs text-brand-label">
                      {ago(ts(row.ts))}
                    </span>
                  </span>
                  <span className="truncate text-sm text-brand-muted">
                    {humanPrompt(row.last_prompt) || row.window}
                  </span>
                  <span className="truncate text-xs text-brand-label">
                    {statusText(
                      row.status,
                      row.waiting_kind,
                      row.running_kind,
                      row.background?.length ?? 0,
                    )}
                    ，{row.cwd.split('/').filter(Boolean).at(-1) ?? ''}
                    {row.branch ? `（${row.branch}）` : ''}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
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
  const client = useQueryClient()
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
  const [pendingRaw, setPending] = useState<Array<Pending>>([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
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
  const blocked =
    device.state !== 'approved'
      ? t`Writing is not enabled on this phone yet (Settings › Phone writing).`
      : data?.waiting_kind
        ? t`The agent is asking for a confirmation: answer it with the keys above.`
        : ''
  const run = async (action: 'send' | 'key', args: Record<string, unknown>) => {
    setSending(true)
    setError('')
    try {
      await remoteLink.write(action, { id, ...args })
      await client.invalidateQueries({ queryKey: ['remote', 'session', id] })
      return true
    } catch (e) {
      setError((e as Error).message)
      return false
    } finally {
      setSending(false)
    }
  }
  const send = async (message: Outgoing) => {
    const ok = await run('send', {
      text: message.text,
      attachments: message.attachments,
    })
    if (ok)
      setPending((items) => [
        ...items,
        { text: message.text, note: message.note, at: Date.now() },
      ])
    return ok
  }
  const composer = useComposer({
    onSend: send,
    diagnostics: () => ({
      session: { id, agent: data?.agent, status: data?.status, busy },
      chat: { pinned: follow.pinned, unread: follow.unread, shown, total },
    }),
  })
  return (
    <div className="grid flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto] gap-3">
      <SessionHeader data={data} onBack={back} />

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
        {data?.waiting_kind ? (
          <div className="grid gap-2 rounded-[16px] bg-brand-surface p-3">
            <p className="text-sm font-medium">{t`The agent asks:`}</p>
            <pre className="max-h-48 overflow-auto font-mono text-[12px] leading-snug text-brand-muted">
              {(data.screen ?? '').split('\n').slice(-14).join('\n')}
            </pre>
            <div className="flex flex-wrap gap-2">
              {[
                ['1', '1'],
                ['2', '2'],
                ['3', '3'],
                ['Enter', t`Enter`],
                ['Escape', t`Esc`],
              ].map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  disabled={sending || device.state !== 'approved'}
                  onClick={() => void run('key', { key })}
                  className="key-press min-h-11 min-w-11 rounded-[12px] border border-brand-edge bg-brand-deck px-3 text-[15px] disabled:opacity-40"
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <div ref={end} />
      </div>

      <form
        className="sticky bottom-0 -mb-4 grid gap-1.5 bg-brand-deck pt-1 pb-[max(env(safe-area-inset-bottom),0.75rem)]"
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
        {error ? (
          <p role="alert" className="text-xs text-brand-error">
            {error}
          </p>
        ) : !blocked && data && isBusy(data) ? (
          <p className="text-xs text-brand-muted">
            {t`The agent is working; it picks up your message during or right after this turn.`}
          </p>
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
        />
      </form>
    </div>
  )
}
