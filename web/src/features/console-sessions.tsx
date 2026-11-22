// 会话: every live agent session on the host (from attention.json via the
// relay), its conversation, and — with an approved device key — a composer
// that pastes into the session's own tmux TUI. Guards live on the host
// (remote_session.go); the page explains them before the user hits them.
import { useLingui } from '@lingui/react/macro'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams, useRouter } from '@tanstack/react-router'
import { ChevronLeft, SendHorizontal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Led } from '#/components/deck/led'
import type { LedTone } from '#/components/deck/led'
import { useLocale } from '#/lib/locale-context'
import { remoteLink } from '#/lib/remote-link'
import { cn } from '#/lib/utils'
import { useDeviceState } from './device-state'
import { useAgo } from './tickets-view'

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
}

type Message = {
  role: 'user' | 'assistant' | 'tool'
  text: string
  ts?: string
}

type Detail = {
  id: string
  status: string
  waiting_kind?: string
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
  return (status: string, kind?: string) =>
    kind
      ? t`waiting for your confirmation`
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
      <h1 className="hidden text-base font-semibold md:block">{t`Sessions`}</h1>
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
                    {row.last_prompt ||
                      statusText(row.status, row.waiting_kind)}
                  </span>
                  <span className="truncate text-xs text-brand-label">
                    {statusText(row.status, row.waiting_kind)}，
                    {row.cwd.split('/').filter(Boolean).at(-1) ?? ''}
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

function ToolGroup({ tools }: { tools: Array<Message> }) {
  const { t } = useLingui()
  const count = tools.length
  return (
    <details className="px-1">
      <summary className="cursor-pointer list-none py-1 text-[12px] text-brand-label">
        {t`Used ${count} tools`} ›
      </summary>
      <div className="grid gap-0.5 pt-1">
        {tools.map((tool, index) => (
          <Bubble key={index} message={tool} />
        ))}
      </div>
    </details>
  )
}

/** Consecutive tool calls collapse into one expandable line. */
function groupTools(messages: Array<Message>) {
  const out: Array<Message | Array<Message>> = []
  for (const message of messages) {
    const last = out.at(-1)
    if (message.role === 'tool') {
      if (Array.isArray(last)) last.push(message)
      else out.push([message])
    } else out.push(message)
  }
  return out
}

function Bubble({ message }: { message: Message }) {
  if (message.role === 'tool') {
    return (
      <p className="truncate px-1 font-mono text-[12px] text-brand-label">
        {message.text}
      </p>
    )
  }
  const mine = message.role === 'user'
  return (
    <div className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
      <p
        className={cn(
          'max-w-[85%] rounded-[18px] px-3.5 py-2.5 text-[15px] leading-relaxed break-words whitespace-pre-wrap',
          mine
            ? 'rounded-br-[6px] bg-brand-text text-brand-deck'
            : 'rounded-bl-[6px] bg-brand-surface text-brand-text',
        )}
      >
        {message.text}
      </p>
    </div>
  )
}

function SessionDetail({ id }: { id: string }) {
  const { t } = useLingui()
  const router = useRouter()
  const navigate = useNavigate()
  const { locale } = useLocale()
  const client = useQueryClient()
  const statusText = useStatusText()
  const device = useDeviceState()
  const detail = useQuery({
    queryKey: ['remote', 'session', id],
    enabled: typeof window !== 'undefined',
    refetchInterval: 2_000,
    queryFn: async () => (await remoteLink.rpc('session', { id })) as Detail,
  })
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const end = useRef<HTMLDivElement>(null)
  const data = detail.data
  const count = data?.messages?.length ?? 0
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [count])
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
      : data?.status === 'running'
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
        setText('')
        toast(t`Sent to the session`)
      }
      await client.invalidateQueries({ queryKey: ['remote', 'session', id] })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSending(false)
    }
  }
  const tone = sessionTone(data?.status ?? '', data?.waiting_kind)
  return (
    <div className="grid min-h-full grid-rows-[auto_minmax(0,1fr)_auto] gap-3">
      <div className="grid gap-2">
        <button
          type="button"
          onClick={back}
          className="-ml-2 inline-flex min-h-11 w-fit items-center gap-1 px-2 text-[15px] text-brand-muted"
        >
          <ChevronLeft size={20} aria-hidden />
          {t`Sessions`}
        </button>
        <p className="inline-flex items-center gap-2 text-sm text-brand-muted">
          <Led tone={tone} size={11} />
          {data ? statusText(data.status, data.waiting_kind) : t`Loading…`}
        </p>
      </div>

      <div className="grid content-end gap-2" aria-live="polite">
        {detail.isError ? (
          <p
            role="status"
            className="rounded-[12px] bg-brand-waiting/10 px-3 py-2 text-sm"
          >
            {String(detail.error.message)}
          </p>
        ) : null}
        {data?.messages?.length ? (
          groupTools(data.messages).map((item, index) =>
            Array.isArray(item) ? (
              <ToolGroup key={`tools-${index}`} tools={item} />
            ) : (
              <Bubble key={`${index}-${item.ts ?? ''}`} message={item} />
            ),
          )
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
        className="sticky bottom-0 grid gap-1.5 bg-brand-deck pt-1 pb-1"
        onSubmit={(event) => {
          event.preventDefault()
          if (text.trim()) void run('send', { text })
        }}
      >
        {error ? (
          <p role="alert" className="text-xs text-brand-error">
            {error}
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
