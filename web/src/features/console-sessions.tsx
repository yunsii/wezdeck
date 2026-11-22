// 会话: every live agent session on the host (from attention.json via the
// relay), its conversation, and — with an approved device key — a composer
// that pastes into the session's own tmux TUI. Guards live on the host
// (remote_session.go); the page explains them before the user hits them.
import { useLingui } from '@lingui/react/macro'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams, useRouter } from '@tanstack/react-router'
import { ChevronLeft, SendHorizontal } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { Led } from '#/components/deck/led'
import type { LedTone } from '#/components/deck/led'
import { useLocale } from '#/lib/locale-context'
import { remoteLink } from '#/lib/remote-link'
import { useDeviceState } from './device-state'
import { useAgo } from './tickets-view'
import { ChatThread, SendQueue, settle } from './chat-thread'
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

type Detail = {
  id: string
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

function useStatusText() {
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

/**
 * Land at the newest message, and follow new ones while the reader is at
 * the bottom. Deferred a few frames: the router's scroll restoration runs
 * after mount and would otherwise put the page back at the top.
 */
function useStickToBottom(
  end: React.RefObject<HTMLDivElement | null>,
  count: number,
) {
  const stuck = useRef(true)
  const landed = useRef(false)
  useEffect(() => {
    if (!count || !stuck.current) return
    const smooth =
      landed.current && !matchMedia('(prefers-reduced-motion: reduce)').matches
    // to the very bottom: the sticky composer would cover the last message
    // if only the end marker were scrolled into view
    const go = () => {
      const scroller = end.current?.closest('.overflow-y-auto')
      if (!scroller) return
      scroller.scrollTo({
        top: scroller.scrollHeight,
        behavior: smooth ? 'smooth' : 'auto',
      })
      landed.current = true
    }
    const frame = requestAnimationFrame(() => requestAnimationFrame(go))
    const timer = setTimeout(go, 150)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
    }
  }, [count])
  // While the reader is at the bottom, follow the thread as it grows — a
  // streaming reply grows every frame without changing the message count.
  useEffect(() => {
    const scroller = end.current?.closest('.overflow-y-auto')
    const thread = end.current?.parentElement
    if (!scroller || !thread || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (stuck.current && landed.current)
        scroller.scrollTop = scroller.scrollHeight
    })
    observer.observe(thread)
    return () => observer.disconnect()
  }, [end])
  useEffect(() => {
    const scroller = end.current?.closest('.overflow-y-auto')
    if (!scroller) return
    const onScroll = () => {
      stuck.current =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [])
}

function SessionHeader({
  data,
  onBack,
}: {
  data: Detail | undefined
  onBack: () => void
}) {
  const { t } = useLingui()
  const statusText = useStatusText()
  const tone = sessionTone(data?.status ?? '', data?.waiting_kind)
  return (
    <div className="grid gap-2">
      <button
        type="button"
        onClick={onBack}
        className="-ml-2 inline-flex min-h-11 w-fit items-center gap-1 px-2 text-[15px] text-brand-muted"
      >
        <ChevronLeft size={20} aria-hidden />
        {t({ message: 'Sessions', context: 'nav' })}
      </button>
      <p className="inline-flex items-center gap-2 text-sm text-brand-muted">
        <Led tone={tone} size={11} />
        {data
          ? statusText(
              data.status,
              data.waiting_kind,
              data.running_kind,
              data.background?.length ?? 0,
            )
          : t`Loading…`}
      </p>
      {data?.background?.length ? (
        <ul
          aria-label={t`Background tasks`}
          className="grid gap-1 rounded-[12px] bg-brand-surface px-3 py-2"
        >
          {data.background.map((task) => (
            <li
              key={task.id}
              className="flex items-center gap-2 truncate font-mono text-[12px] text-brand-muted"
            >
              <Led tone="running" size={9} />
              {task.summary || task.id}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
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
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const end = useRef<HTMLDivElement>(null)
  const data = detail.data
  const messages: Array<Message> = data?.messages ?? []
  const pending = settle(pendingRaw, messages)
  const busy = Boolean(data && isBusy(data))
  useStickToBottom(end, messages.length + pending.length + (busy ? 1 : 0))
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
      : data && isBusy(data) && data.agent !== 'claude'
        ? t`The agent is working. You can send once it stops.`
        : data?.waiting_kind
          ? t`The agent is asking for a confirmation: answer it with the keys above.`
          : ''
  const run = async (action: 'send' | 'key', args: Record<string, unknown>) => {
    setSending(true)
    setError('')
    try {
      await remoteLink.write(action, { id, ...args })
      if (action === 'send') {
        const sent = String(args.text ?? '')
        setText('')
        setPending((items) => [...items, { text: sent, at: Date.now() }])
      }
      await client.invalidateQueries({ queryKey: ['remote', 'session', id] })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSending(false)
    }
  }
  return (
    <div className="grid min-h-full grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto] gap-3">
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
        className="sticky bottom-0 grid gap-1.5 bg-brand-deck pt-1 pb-[max(env(safe-area-inset-bottom),0.25rem)]"
        onSubmit={(event) => {
          event.preventDefault()
          if (text.trim()) void run('send', { text })
        }}
      >
        {detail.isError && data ? (
          <p
            role="status"
            data-testid="session-stale"
            className="rounded-[10px] bg-brand-waiting/10 px-3 py-1.5 text-xs text-brand-text"
          >
            {t`Can't get the latest from the host, showing ${staleAt}:`}{' '}
            {detail.error.message}
          </p>
        ) : null}
        <SendQueue pending={pending} busy={busy} />
        {error ? (
          <p role="alert" className="text-xs text-brand-error">
            {error}
          </p>
        ) : !blocked && data && isBusy(data) ? (
          <p className="text-xs text-brand-muted">
            {t`Claude is working; your message joins its queue and it decides when to take it.`}
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
        <div className="flex items-end gap-2 rounded-[22px] bg-brand-surface p-1.5">
          <label htmlFor="session-composer" className="sr-only">
            {t`Message to the agent`}
          </label>
          <textarea
            id="session-composer"
            value={text}
            onFocus={(event) => {
              // keep the composer above the keyboard once it has opened
              const form = event.currentTarget.form
              setTimeout(() => form?.scrollIntoView({ block: 'end' }), 300)
            }}
            onChange={(event) => setText(event.target.value)}
            rows={1}
            placeholder={t`Message`}
            className="max-h-40 min-h-10 flex-1 resize-none bg-transparent px-3 py-2 text-[16px] outline-none [field-sizing:content] placeholder:text-brand-label"
          />
          <button
            type="submit"
            aria-label={t`Send`}
            disabled={sending || !text.trim() || Boolean(blocked)}
            className="inline-flex size-10 items-center justify-center rounded-full bg-brand-text text-brand-deck disabled:opacity-30"
          >
            <SendHorizontal size={18} aria-hidden />
          </button>
        </div>
      </form>
    </div>
  )
}
