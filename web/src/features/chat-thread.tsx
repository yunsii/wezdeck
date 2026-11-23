// The conversation on a phone: Markdown replies, one collapsed line per run
// of tool calls, and motion only where something just happened — messages
// that arrive after the page opened slide in and a new reply writes itself
// word by word, each word blurring in; nothing animates under
// prefers-reduced-motion.
import { useLingui } from '@lingui/react/macro'
import { memo, useCallback, useEffect, useRef, useState } from 'react'

import { formatElapsed, formatTokens, useNow } from '#/lib/turn-progress'
import { cn } from '#/lib/utils'
import { Led } from '#/components/deck/led'
import { ChatMarkdown } from './chat-markdown'
import { useStream } from './chat-stream'
import { ImageStrip, SessionIdContext, TranscriptImages } from './chat-images'
import { ToolGroup, canBackground } from './chat-tools'
import { Disclosure } from '#/components/ui/disclosure'
import { SlashCommandRow } from './chat-command'

export type Message = {
  /** system + kind "compact": context compaction marker (text = auto | manual, body = summary) */
  role: 'user' | 'assistant' | 'tool' | 'system'
  text: string
  ts?: string
  tool?: string
  body?: string
  result?: string
  file?: string
  added?: number
  removed?: number
  /** the call went out and its result has not come back yet */
  pending?: boolean
  /** the call asked to run in the background (run_in_background) */
  background?: boolean
  /** shared tool kind: command | read | edit | write | search | task | todo | web | ask | other */
  kind?: string
  /** refs to images embedded in the transcript (session.image) */
  images?: Array<string>
}

export type Pending = {
  text: string
  /** ms when sent; also the key */
  at: number
  note?: string
  /** absolute transcript index where the transcript ended when it was sent */
  after?: number
  /** sending: the host has not taken it yet; queued: in the pane, not yet in the transcript */
  state?: 'sending' | 'queued'
}

/** First line of the note the host appends for phone attachments (remote_upload.go). */
const ATTACHMENT_MARK = '[手机附件]'

/** What the user typed, without the host's attachment note. */
export const typedText = (text: string) => splitAttachments(text).typed

/** Split a sent message into what was typed and its attachment lines. */
function splitAttachments(text: string) {
  const at = text.indexOf(ATTACHMENT_MARK)
  if (at < 0) return { typed: text, files: [] }
  const files = text
    .slice(at + ATTACHMENT_MARK.length)
    .split('\n')
    .map((line) => line.replace(/^- /, '').trim())
    .filter(Boolean)
    .map((line) => {
      const [label = '', path = ''] = line.split(/:\s+/, 2)
      return { label, name: path.split('/').at(-1) ?? path }
    })
  return { typed: text.slice(0, at).trim(), files }
}

const isPhoneImage = (name: string) =>
  /^img-.*\.(jpe?g|png|gif|webp)$/i.test(name)

function SentAttachments({ text }: { text: string }) {
  const { typed, files } = splitAttachments(text)
  const images = files.filter((file) => isPhoneImage(file.name))
  const others = files.filter((file) => !isPhoneImage(file.name))
  return (
    <>
      {typed}
      <ImageStrip
        sources={images.map((file) => ({ kind: 'upload', name: file.name }))}
      />
      {others.length ? (
        <span className="mt-1.5 flex flex-wrap gap-1">
          {others.map((file) => (
            <span
              key={file.name}
              title={file.name}
              className="rounded-full bg-brand-deck/15 px-2 py-0.5 text-meta"
            >
              {file.label}
            </span>
          ))}
        </span>
      ) : null}
    </>
  )
}

/**
 * Memoised: a poll that appends a message leaves the others alone — merged
 * messages keep their identity, so a settled bubble skips its markdown parse.
 */
const Bubble = memo(function BubbleView({
  message,
  at,
  fresh,
  stream,
  rush = false,
  onShown,
}: {
  message: Message
  /** absolute transcript index; marks the user's messages for StickyPrompt */
  at: number
  fresh: boolean
  /** this is the reply being streamed in right now */
  stream: boolean
  /** messages are queued behind this one: stream faster to catch up */
  rush?: boolean
  onShown?: () => void
}) {
  const mine = message.role === 'user'
  const live = useStream(message.text, stream && !mine, onShown, rush)
  useEffect(() => {
    if (stream && mine) onShown?.()
  }, [stream, mine, onShown])
  return (
    <div className={cn('grid min-w-0', fresh && 'chat-in')}>
      {/* full width; who wrote it is told by the background alone */}
      <div
        data-user-at={mine ? at : undefined}
        className={cn(
          'min-w-0 rounded-xl px-3.5 py-2.5',
          mine
            ? 'bg-brand-text text-body leading-relaxed break-words whitespace-pre-wrap text-brand-deck'
            : 'bg-brand-surface text-brand-text',
        )}
      >
        {mine ? (
          <>
            <SentAttachments text={message.text} />
            <TranscriptImages refs={message.images} />
          </>
        ) : (
          <ChatMarkdown text={live.text} streaming={live.streaming} />
        )}
      </div>
    </div>
  )
})

export type Item =
  | { kind: 'message'; message: Message; index: number }
  | { kind: 'tools'; tools: Array<Message>; index: number }

/**
 * A run of tool calls can grow after it was revealed (the agent is still
 * calling tools); a cursor left inside it would match no item and stall the
 * thread until the page reopens. Move such a cursor to the end of the run.
 */
export function settleCursor(
  items: Array<Item>,
  start: number,
  cursor: number,
) {
  for (const item of items) {
    if (item.kind !== 'tools') continue
    const from = start + item.index
    const to = from + item.tools.length
    if (from < cursor && cursor < to) return to
  }
  return cursor
}

/**
 * The agent waits on a foreground command or subagent: the newest message is
 * a call Ctrl+B can move to the background (chat-tools canBackground). That
 * call's own row then offers 转到后台.
 */
export function foregroundCall(messages: Array<Message>) {
  const last = messages.at(-1)
  return Boolean(last && canBackground(last))
}

/** Consecutive tool calls collapse into one expandable line. */
export function group(messages: Array<Message>) {
  const out: Array<Item> = []
  messages.forEach((message, index) => {
    const last = out.at(-1)
    if (message.role === 'tool') {
      if (last?.kind === 'tools') last.tools.push(message)
      else out.push({ kind: 'tools', tools: [message], index })
    } else out.push({ kind: 'message', message, index })
  })
  return out
}

/** The running turn, from hooks (lib/turn-progress.ts). */
export type Activity = {
  /** ms: when the turn began (attention turn_started) */
  since?: number
  /** ms: when a context compaction began; set only while it runs */
  compactSince?: number
  /** output tokens of the turn so far */
  tokens?: number
}

/**
 * The agent is working: one quiet row — the running light, then "Working…
 * 4m 39s · ↓ 19.1k tokens", or "Compacting conversation… 36s" in amber while
 * the context is compacted. Always the same shape, whether or not a tool
 * call is out (it used to swap between a dots bubble and a bare line on
 * every tool call).
 */
function Typing({ activity }: { activity?: Activity }) {
  const { t } = useLingui()
  const compacting = activity?.compactSince !== undefined
  const from = activity?.compactSince ?? activity?.since
  const now = useNow(from !== undefined)
  const label = compacting ? t`Compacting conversation` : t`Working`
  const tokens =
    !compacting && activity?.tokens ? formatTokens(activity.tokens) : ''
  const detail = [
    from !== undefined ? formatElapsed(now - from) : '',
    tokens ? t`↓ ${tokens} tokens` : '',
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="chat-in flex min-w-0 items-center gap-2">
      <div
        role="status"
        aria-label={detail ? `${label} ${detail}` : t`The agent is working`}
        data-activity={compacting ? 'compacting' : 'working'}
        className="flex min-w-0 flex-1 items-center gap-2 px-1 py-0.5"
      >
        <Led
          tone={compacting ? 'waiting' : 'running'}
          size={9}
          className="led-running"
        />
        <span className="min-w-0 truncate text-caption text-brand-muted">
          <span className={cn(compacting && 'text-brand-waiting')}>
            {label}…
          </span>
          {detail ? (
            <span className="ml-1.5 text-brand-label tabular-nums">
              {detail}
            </span>
          ) : null}
        </span>
      </div>
    </div>
  )
}

export function ChatThread({
  messages,
  start,
  busy,
  activity,
  pending = [],
  onBackground,
  sessionId = '',
}: {
  /** Claude, writable: Ctrl+B into the pane (shown while a foreground call runs) */
  onBackground?: () => void
  messages: Array<Message>
  /** sent from the phone (unsettled): settled here against what is shown */
  pending?: Array<Pending>
  /** the TUI status line while busy (compacting, elapsed, tokens) */
  activity?: Activity
  /** resolves transcript image refs (session.image) */
  sessionId?: string
  /** absolute index of messages[0] in the whole transcript (pagination) */
  start: number
  busy: boolean
}) {
  // Messages present when the page opened render still. Later ones are
  // revealed one at a time through `cursor` (absolute index of the first
  // message not shown yet): a reply streams in, a user message or a run of
  // tool calls just appears, then the next one goes. Absolute indices, so
  // loading earlier messages neither re-keys nor replays anything.
  const end = start + messages.length
  const baseline = useRef<number | null>(null)
  const [cursor, setCursor] = useState<number | null>(null)
  if (baseline.current === null && messages.length > 0) baseline.current = end
  // a long backlog (phone was away) jumps to the newest instead of replaying
  const items = group(messages)
  const effective = settleCursor(
    items,
    start,
    cursor === null ? (baseline.current ?? end) : Math.max(cursor, end - 8),
  )
  const advance = useCallback(
    (to: number) => setCursor((current) => Math.max(current ?? 0, to)),
    [],
  )
  const isFresh = (index: number) =>
    baseline.current !== null && start + index >= baseline.current
  // items waiting behind the one streaming now: two or more → catch up
  const queued = items.filter((item) => start + item.index > effective).length
  const renderItem = (item: Item, position: number, at: number) => {
    const stream = at === effective
    if (item.kind === 'tools') {
      const live = busy && position === items.length - 1
      return (
        <ToolGroup
          key={`t${at}`}
          tools={item.tools}
          fresh={isFresh(item.index)}
          stream={stream}
          live={live}
          onBackground={
            live && foregroundCall(item.tools) ? onBackground : undefined
          }
          onShown={stream ? () => advance(at + item.tools.length) : undefined}
        />
      )
    }
    if (item.message.role === 'system') {
      if (item.message.kind === 'slash')
        return (
          <SlashCommandRow
            key={`m${at}`}
            message={item.message}
            onShown={stream ? () => advance(at + 1) : undefined}
          />
        )
      return (
        <CompactDivider
          key={`m${at}`}
          message={item.message}
          onShown={stream ? () => advance(at + 1) : undefined}
        />
      )
    }
    return (
      <Bubble
        key={`m${at}`}
        message={item.message}
        at={at}
        fresh={isFresh(item.index)}
        stream={stream}
        rush={queued >= 2}
        onShown={stream ? () => advance(at + 1) : undefined}
      />
    )
  }
  return (
    <SessionIdContext.Provider value={sessionId}>
      {/* what is on screen, for `wezdeck-wsl diag` (client-trace
          renderedChat): the reveal cursor, then every drawn item's
          transcript index and role, to compare with the host transcript
          when a message seems lost */}
      <span hidden data-chat-reveal={effective} data-chat-end={end} />
      {items.map((item, position) => {
        const at = start + item.index
        if (at > effective) return null
        return (
          <div
            key={`${item.kind}${at}`}
            data-msg={at}
            data-role={item.kind === 'tools' ? 'tool' : item.message.role}
            className="contents"
          >
            {renderItem(item, position, at)}
          </div>
        )
      })}
      {/* settle against the revealed messages only: the faded bubble
          stays until its normal bubble is on screen, not while an earlier
          reply is still unfolding */}
      <PendingBubbles
        pending={settle(
          pending,
          messages.slice(0, Math.max(0, effective - start + 1)),
          start,
          busy,
        )}
      />
      {/* last: the working line says what the agent does now, below
          everything in the thread — queued messages included */}
      {busy && effective >= end ? <Typing activity={activity} /> : null}
    </SessionIdContext.Provider>
  )
}

/**
 * Context compaction: everything above was summarised for the agent. The
 * summary it continues from is one tap away; earlier history is still in the
 * transcript (the page stops loading there unless asked).
 */
function CompactDivider({
  message,
  onShown,
}: {
  message: Message
  /** the reveal cursor sits here: nothing to animate, move on */
  onShown?: () => void
}) {
  const { t } = useLingui()
  useEffect(() => {
    onShown?.()
  }, [onShown])
  if (message.kind !== 'compact') return null
  const when = message.ts
    ? new Date(message.ts).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      })
    : ''
  const label =
    message.text === 'manual'
      ? t`Context compacted (/compact)`
      : t`Context compacted automatically`
  return (
    <Disclosure
      className="py-1"
      data-testid="compact-divider"
      chevron={false}
      triggerClassName="text-meta text-brand-label"
      title={
        <>
          <span className="h-px flex-1 bg-brand-edge" />
          <span>
            {label}
            {when ? ` ${when}` : ''}
            {message.body ? (
              <span className="ml-1 underline-offset-2 group-data-[panel-open]:hidden">
                {t`· summary`}
              </span>
            ) : null}
          </span>
          <span className="h-px flex-1 bg-brand-edge" />
        </>
      }
    >
      {message.body ? (
        <p className="mt-2 max-h-72 overflow-y-auto rounded-xl bg-brand-surface px-3 py-2 text-caption leading-relaxed whitespace-pre-wrap text-brand-muted">
          {message.body}
        </p>
      ) : null}
    </Disclosure>
  )
}

/**
 * Messages sent from the phone that the agent has not taken yet: at the end
 * of the thread, the user bubble faded, like Claude Code's queued input. Once the
 * transcript shows one, settle() drops it and the normal user bubble takes
 * its place — in whatever order the agent picks them up.
 */
function PendingBubbles({ pending }: { pending: Array<Pending> }) {
  const { t } = useLingui()
  if (pending.length === 0) return null
  return (
    <div aria-label={t`Queued messages`} className="grid gap-1.5">
      {pending.map((item) => (
        // the user bubble itself, faded (like Claude Code's queued input);
        // it turns solid once the agent takes the message
        <div
          key={item.at}
          data-pending={item.state ?? 'queued'}
          className="chat-in min-w-0 rounded-xl bg-brand-text px-3.5 py-2.5 text-body leading-relaxed break-words whitespace-pre-wrap text-brand-deck opacity-55"
        >
          {item.text}
          {item.note ? (
            <span className="opacity-70">
              {item.text ? ' ' : ''}({item.note})
            </span>
          ) : null}
        </div>
      ))}
    </div>
  )
}

/**
 * Drop optimistic bubbles the transcript now shows: each user line after
 * the point a message was sent settles at most one bubble, so two identical
 * messages need two lines and an earlier identical one never counts. A
 * bubble the transcript never shows goes a minute after the agent is idle
 * (never while it works: a long turn keeps the queue).
 */
export function settle(
  pending: Array<Pending>,
  messages: Array<Message>,
  start = 0,
  busy = false,
  now = Date.now(),
) {
  const users = messages
    .map((message, index) => ({ message, at: start + index }))
    .filter(({ message }) => message.role === 'user')
    .map(({ message, at }) => ({ text: message.text.trim(), at }))
  const used = new Set<number>()
  // the host appends an attachment note after a blank line
  const matches = (typed: string, text: string) =>
    typed
      ? text === typed || text.startsWith(`${typed}\n\n${ATTACHMENT_MARK}`)
      : text.startsWith(ATTACHMENT_MARK)
  return pending.filter((item) => {
    const typed = item.text.trim()
    const line = users.find(
      (user) =>
        !used.has(user.at) &&
        user.at >= (item.after ?? 0) &&
        matches(typed, user.text),
    )
    if (line) {
      used.add(line.at)
      return false
    }
    if (item.state === 'sending' || busy) return true
    return now - item.at < 60_000
  })
}
