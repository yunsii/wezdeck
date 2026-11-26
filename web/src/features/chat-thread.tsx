// The conversation on a phone: Markdown replies, one collapsed line per run
// of tool calls, and motion only where something just happened — messages
// that arrive after the page opened slide in and a new reply writes itself
// word by word, each word blurring in; nothing animates under
// prefers-reduced-motion.
import { useLingui } from '@lingui/react/macro'
import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'

import { SentAttachments, endsWithNote } from './chat-attachments'
import { PendingBubbles } from './chat-pending'
import { TurnLine, revealingTurnState, turnState } from './chat-turn'
import type { Activity } from './chat-turn'
import { cn } from '#/lib/utils'
import { ChatMarkdown } from './chat-markdown'
import { useStream } from './chat-stream'
import { SmoothGrow } from './chat-grow'
import { catchUp, useCatchUpSignal } from './chat-catchup'
import { SessionIdContext, TranscriptImages } from './chat-images'
import { ToolGroup, canBackground } from './chat-tools'
import { Disclosure } from '#/components/ui/disclosure'
import { ApiErrorRow, SlashCommandRow, TaskEventRow } from './chat-command'

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
  /** uploaded names sent with it: the bubble shows them as the message will */
  attachments?: Array<string>
  /** absolute transcript index where the transcript ended when it was sent */
  after?: number
  /**
   * sending: the host has not taken it yet; queued: in the pane, not yet in
   * the transcript; lost: derived by settle() — the agent went idle and the
   * transcript never showed it (未送达, offered for resend)
   */
  state?: 'sending' | 'queued' | 'lost'
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
  settles = false,
  onShown,
}: {
  message: Message
  /** absolute transcript index; marks the user's messages for StickyPrompt */
  at: number
  fresh: boolean
  /** replaces a faded queued bubble: solidify in place, no slide-in */
  settles?: boolean
  /** this is the reply being streamed in right now */
  stream: boolean
  /** messages are queued behind this one: stream faster to catch up */
  rush?: boolean
  onShown?: () => void
}) {
  const mine = message.role === 'user'
  const live = useStream(message.text, stream && !mine, onShown, rush)
  // decided once at mount: a later render (the queued bubble gone from the
  // list, a poll) must not swap the class and replay an entrance
  const [entry] = useState(() =>
    settles ? 'chat-settle' : fresh ? 'chat-in' : '',
  )
  useEffect(() => {
    if (stream && mine) onShown?.()
  }, [stream, mine, onShown])
  return (
    <div className={cn('grid min-w-0', entry)}>
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

/** items rendered at once when a conversation opens; the rest follow */
const FIRST_ITEMS = 12
/** items added per idle slice after that */
const ITEM_CHUNK = 20

/**
 * The first item index to render. A conversation opens with its newest
 * FIRST_ITEMS (it lands at its bottom, so that is the screen), then the
 * earlier ones are added ITEM_CHUNK at a time when the browser is idle, as a
 * transition (never blocking input); the browser's scroll anchoring keeps
 * the view still as they land above. Rendering and parsing the markdown of
 * a whole page at once held the main thread ~80 ms on every switch. Once
 * everything is in, it stays -Infinity: 加载更早 and new messages render as
 * before.
 */
function useProgressiveFloor(items: Array<Item>, start: number) {
  const first =
    items.length > FIRST_ITEMS
      ? start + items[items.length - FIRST_ITEMS].index
      : -Infinity
  const [floor, setFloor] = useState<number | null>(null)
  const current = floor ?? first
  useEffect(() => {
    if (current === -Infinity) return
    const step = () =>
      startTransition(() =>
        setFloor((was) => {
          const at = was ?? first
          const pos = items.findIndex((item) => start + item.index >= at)
          return pos <= ITEM_CHUNK
            ? -Infinity
            : start + items[pos - ITEM_CHUNK].index
        }),
      )
    if (typeof requestIdleCallback === 'function') {
      const id = requestIdleCallback(step, { timeout: 300 })
      return () => cancelIdleCallback(id)
    }
    const id = setTimeout(step, 50)
    return () => clearTimeout(id)
    // items read at call time; the floor moving is what re-arms
  }, [current, start])
  return current
}

export function ChatThread({
  messages,
  start,
  busy,
  activity,
  pending = [],
  status,
  statusTs,
  onBackground,
  onResend,
  onDismiss,
  sessionId = '',
}: {
  /** a lost (未送达) bubble: send it again / drop it */
  onResend?: (item: Pending) => void
  onDismiss?: (item: Pending) => void
  /** Claude, writable: Ctrl+B into the pane (shown while a foreground call runs) */
  onBackground?: () => void
  messages: Array<Message>
  /** sent from the phone (unsettled): settled here against what is shown */
  pending?: Array<Pending>
  /** the TUI status line while busy (compacting, elapsed, tokens) */
  activity?: Activity
  /** the entry's status and its last change (ms), for the turn line */
  status?: string
  statusTs?: number
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
  const items = group(messages)
  // the first message not shown yet; a backlog (page was hidden, phone
  // locked) shows all but its newest reply at once (chat-catchup.ts)
  const from = cursor === null ? (baseline.current ?? end) : cursor
  const caught = catchUp(items, start, from)
  const effective = settleCursor(items, start, caught)
  const skippedFrom = caught > from ? from : null
  useCatchUpSignal(skippedFrom)
  // shown at once by a catch-up: no entrance, they were not watched arriving
  const skipped = (at: number) =>
    skippedFrom !== null && at >= skippedFrom && at < effective
  const advance = useCallback(
    (to: number) => setCursor((current) => Math.max(current ?? 0, to)),
    [],
  )
  const isFresh = (index: number) =>
    baseline.current !== null && start + index >= baseline.current
  // settle against the revealed messages only: the faded bubble stays
  // until its normal bubble is on screen, not while an earlier reply is
  // still unfolding — and that bubble then solidifies in its place
  const queue = settleMatches(
    pending,
    messages.slice(0, Math.max(0, effective - start + 1)),
    start,
    busy,
  )
  // items waiting behind the one streaming now: two or more → catch up
  const queued = items.filter((item) => start + item.index > effective).length
  const floor = useProgressiveFloor(items, start)
  const renderItem = (item: Item, position: number, at: number) => {
    const stream = at === effective
    if (item.kind === 'tools') {
      const live = busy && position === items.length - 1
      return (
        <ToolGroup
          key={`t${at}`}
          tools={item.tools}
          fresh={isFresh(item.index) && !skipped(at)}
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
      if (item.message.kind === 'task')
        return (
          <TaskEventRow
            key={`m${at}`}
            message={item.message}
            onShown={stream ? () => advance(at + 1) : undefined}
          />
        )
      if (item.message.kind === 'error')
        return (
          <ApiErrorRow
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
        fresh={isFresh(item.index) && !skipped(at)}
        stream={stream}
        rush={queued >= 2}
        settles={queue.took.has(at)}
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
      {/* the thread's own grid inside the easing box (chat-grow.tsx) */}
      <SmoothGrow
        active={busy || effective < end}
        className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2"
      >
        {items.map((item, position) => {
          const at = start + item.index
          if (at > effective || at < floor) return null
          return (
            // a block, not `contents`: content-visibility lets the browser
            // skip style / layout / paint of the messages off screen (a
            // switch laid out the whole conversation: ~120 ms of native work)
            <div
              key={`${item.kind}${at}`}
              data-msg={at}
              data-role={item.kind === 'tools' ? 'tool' : item.message.role}
              className="chat-item"
            >
              {renderItem(item, position, at)}
            </div>
          )
        })}
        <PendingBubbles
          pending={queue.left}
          onResend={onResend}
          onDismiss={onDismiss}
        />
      </SmoothGrow>
      {/* last: the turn line says what the agent does now (working, or
          how long the last turn took), below everything in the thread —
          queued messages included. One element in one place, its text
          changing: it used to appear and vanish with each turn */}
      {/* always mounted (revealingTurnState): it used to drop out while new
          messages were revealed, then come back with its entrance */}
      <TurnLine
        state={revealingTurnState(
          turnState({
            messages,
            left: queue.left,
            busy,
            status,
            statusTs,
            activity,
          }),
          effective < end,
        )}
      />
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
 * Drop optimistic bubbles the transcript now shows: each user line after
 * the point a message was sent settles at most one bubble, so two identical
 * messages need two lines and an earlier identical one never counts. A
 * bubble the transcript never shows turns lost a minute after it was sent
 * once the agent is idle (never while it works: a long turn keeps the
 * queue). It used to vanish silently then, so a paste the TUI swallowed
 * (a half-typed draft at the desk, an open completion menu) looked
 * delivered; now it stays as 未送达 until resent or removed, and a later
 * transcript line still settles it.
 */
/** how long after sending an unmatched message counts as lost (agent idle) */
export const LOST_AFTER_MS = 60_000

export function settle(
  pending: Array<Pending>,
  messages: Array<Message>,
  start = 0,
  busy = false,
  now = Date.now(),
) {
  return settleMatches(pending, messages, start, busy, now).left
}

/** settle(), plus the transcript index of each line that settled a bubble */
export function settleMatches(
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
    typed ? text === typed || endsWithNote(text, typed) : endsWithNote(text, '')
  const left: Array<Pending> = []
  for (const item of pending) {
    const typed = item.text.trim()
    const line = users.find(
      (user) =>
        !used.has(user.at) &&
        user.at >= (item.after ?? 0) &&
        matches(typed, user.text),
    )
    if (line) {
      used.add(line.at)
      continue
    }
    const waiting = item.state === 'sending' || busy
    left.push(
      waiting || now - item.at < LOST_AFTER_MS
        ? item
        : { ...item, state: 'lost' },
    )
  }
  return { left, took: used }
}
