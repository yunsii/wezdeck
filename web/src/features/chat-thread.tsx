// The conversation on a phone: Markdown replies, one collapsed line per run
// of tool calls, and motion only where something just happened — messages
// that arrive after the page opened slide in and a new reply writes itself
// word by word, each word blurring in; nothing animates under
// prefers-reduced-motion.
import { useLingui } from '@lingui/react/macro'
import { memo, useCallback, useEffect, useRef, useState } from 'react'

import { cn } from '#/lib/utils'
import { ChatMarkdown } from './chat-markdown'
import { ImageStrip, SessionIdContext, TranscriptImages } from './chat-images'
import { ToolGroup } from './chat-tools'
import { Disclosure } from '#/components/ui/disclosure'

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
  /** shared tool kind: command | read | edit | write | search | task | todo | web | ask | other */
  kind?: string
  /** refs to images embedded in the transcript (session.image) */
  images?: Array<string>
}

export type Pending = { text: string; at: number; note?: string }

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
              className="rounded-full bg-brand-deck/15 px-2 py-0.5 text-[12px]"
            >
              {file.label}
            </span>
          ))}
        </span>
      ) : null}
    </>
  )
}

const reducedMotion = () =>
  typeof matchMedia !== 'undefined' &&
  matchMedia('(prefers-reduced-motion: reduce)').matches

/** a new batch every 120 ms: calm, phrase-sized steps rather than a ticker */
const TICK_MS = 120
/** let the last batch finish fading in (reveal duration in chat-markdown.tsx) */
const SETTLE_MS = 700
const BREAK = /[\s，。！？；：、,.!?;:）)\]】」』]/

/**
 * Where the next batch ends: at least `step` chars on, then on to the next
 * phrase break (punctuation or space) if one is near, else the end of the
 * word; a batch reads as a phrase appearing, not letters ticking in.
 */
function batchEnd(text: string, from: number, step: number) {
  let end = Math.min(text.length, from + step)
  const reach = Math.min(text.length, end + step)
  for (let at = end; at < reach; at++)
    if (BREAK.test(text[at] ?? '')) return at + 1
  while (end < text.length && /[\w\-./:@#%&+=~]/.test(text[end] ?? '')) end++
  return end
}

/**
 * Stream a just-arrived reply in the way Gemini's feels: a phrase-sized
 * batch every 120 ms at a reading pace (about 350 chars/s, the whole
 * message in 0.6–3 s), each batch fading in softly (chat-markdown.tsx) while
 * the thread glides down after it (chat-scroll.ts). Text that grows
 * mid-stream continues from where it is, never from the start.
 */
function useStream(text: string, active: boolean, onDone?: () => void) {
  const [shown, setShown] = useState(active ? 0 : text.length)
  // the last words are still blurring in when the text is complete
  const [settling, setSettling] = useState(false)
  const at = useRef(shown)
  const done = useRef(onDone)
  done.current = onDone
  useEffect(() => {
    if (!active || reducedMotion() || document.hidden) {
      at.current = text.length
      setShown(text.length)
      done.current?.()
      return
    }
    const total = Math.min(3000, Math.max(600, (text.length / 350) * 1000))
    const step = Math.max(2, Math.ceil(text.length / (total / TICK_MS)))
    let tail: ReturnType<typeof setTimeout> | undefined
    const timer = setInterval(() => {
      at.current = batchEnd(text, at.current, step)
      setShown(at.current)
      if (at.current >= text.length) {
        clearInterval(timer)
        setSettling(true)
        tail = setTimeout(() => {
          setSettling(false)
          done.current?.()
        }, SETTLE_MS)
      }
    }, TICK_MS)
    return () => {
      clearInterval(timer)
      clearTimeout(tail)
    }
  }, [text, active])
  return {
    text: text.slice(0, shown),
    streaming: active && (shown < text.length || settling),
  }
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
  onShown,
}: {
  message: Message
  /** absolute transcript index; marks the user's messages for StickyPrompt */
  at: number
  fresh: boolean
  /** this is the reply being streamed in right now */
  stream: boolean
  onShown?: () => void
}) {
  const mine = message.role === 'user'
  const live = useStream(message.text, stream && !mine, onShown)
  useEffect(() => {
    if (stream && mine) onShown?.()
  }, [stream, mine, onShown])
  return (
    <div className={cn('grid min-w-0', fresh && 'chat-in')}>
      {/* full width; who wrote it is told by the background alone */}
      <div
        data-user-at={mine ? at : undefined}
        className={cn(
          'min-w-0 rounded-[14px] px-3.5 py-2.5',
          mine
            ? 'bg-brand-text text-[15px] leading-relaxed break-words whitespace-pre-wrap text-brand-deck'
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

/** The newest item is a run of tool calls with one still out: its light says "working". */
const callInFlight = (items: Array<Item>) => {
  const last = items.at(-1)
  return last?.kind === 'tools' && last.tools.some((tool) => tool.pending)
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

function Typing() {
  const { t } = useLingui()
  return (
    <div
      className="chat-in flex justify-start"
      aria-label={t`The agent is working`}
    >
      <div className="flex gap-1 rounded-[14px] bg-brand-surface px-3.5 py-3">
        <span className="typing-dot" />
        <span className="typing-dot [animation-delay:150ms]" />
        <span className="typing-dot [animation-delay:300ms]" />
      </div>
    </div>
  )
}

export function ChatThread({
  messages,
  start,
  busy,
  sessionId = '',
}: {
  messages: Array<Message>
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
  return (
    <SessionIdContext.Provider value={sessionId}>
      {items.map((item, position) => {
        const at = start + item.index
        if (at > effective) return null
        const stream = at === effective
        if (item.kind === 'tools')
          return (
            <ToolGroup
              key={`t${at}`}
              tools={item.tools}
              fresh={isFresh(item.index)}
              stream={stream}
              live={busy && position === items.length - 1}
              onShown={
                stream ? () => advance(at + item.tools.length) : undefined
              }
            />
          )
        if (item.message.role === 'system') {
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
            onShown={stream ? () => advance(at + 1) : undefined}
          />
        )
      })}
      {busy && effective >= end && !callInFlight(items) ? <Typing /> : null}
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
      triggerClassName="text-[12px] text-brand-label"
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
        <p className="mt-2 max-h-72 overflow-y-auto rounded-[12px] bg-brand-surface px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap text-brand-muted">
          {message.body}
        </p>
      ) : null}
    </Disclosure>
  )
}

/** Messages sent from the phone, queued above the composer until the transcript shows them. */
export function SendQueue({
  pending,
  busy,
}: {
  pending: Array<Pending>
  busy: boolean
}) {
  const { t } = useLingui()
  if (pending.length === 0) return null
  const count = pending.length
  return (
    <div aria-label={t`Queued messages`} className="grid gap-1.5">
      <span className="text-[11px] text-brand-label">
        {busy
          ? t`${count} queued, the agent takes them when it is ready`
          : t`${count} delivered, waiting for the agent`}
      </span>
      {pending.map((item) => (
        <div
          key={item.at}
          className="chat-in truncate rounded-[14px] border border-dashed border-brand-edge px-3 py-1.5 text-[14px] text-brand-muted"
        >
          {item.text}
          {item.note ? (
            <span className="text-brand-label">
              {item.text ? ' ' : ''}({item.note})
            </span>
          ) : null}
        </div>
      ))}
    </div>
  )
}

/** Drop optimistic bubbles once the transcript shows them (or after a minute). */
export function settle(pending: Array<Pending>, messages: Array<Message>) {
  const users = messages
    .filter((message) => message.role === 'user')
    .map((message) => message.text.trim())
  // the host appends an attachment note after a blank line
  const shows = (typed: string) =>
    users.some((text) =>
      typed
        ? text === typed || text.startsWith(`${typed}\n\n${ATTACHMENT_MARK}`)
        : text.startsWith(ATTACHMENT_MARK),
    )
  return pending.filter(
    (item) => Date.now() - item.at < 60_000 && !shows(item.text.trim()),
  )
}
