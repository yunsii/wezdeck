// The conversation on a phone: Markdown replies, one collapsed line per run
// of tool calls, and motion only where something just happened — messages
// that arrive after the page opened slide in and a new reply unfolds over at
// most half a second; nothing animates under prefers-reduced-motion.
import { useLingui } from '@lingui/react/macro'
import { useEffect, useRef, useState } from 'react'

import { cn } from '#/lib/utils'
import { ChatMarkdown } from './chat-markdown'

export type Message = {
  role: 'user' | 'assistant' | 'tool'
  text: string
  ts?: string
  tool?: string
  body?: string
  result?: string
}

export type Pending = { text: string; at: number }

const reducedMotion = () =>
  typeof matchMedia !== 'undefined' &&
  matchMedia('(prefers-reduced-motion: reduce)').matches

/** Grow the visible text to its full length over ≤ 500 ms. */
function useReveal(text: string, animate: boolean) {
  const [shown, setShown] = useState(animate ? 0 : text.length)
  useEffect(() => {
    if (!animate || reducedMotion()) {
      setShown(text.length)
      return
    }
    const started = performance.now()
    const total = Math.min(500, 120 + text.length * 2)
    let frame = 0
    const tick = (now: number) => {
      const progress = Math.min(1, (now - started) / total)
      setShown(Math.ceil(text.length * progress))
      if (progress < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [text, animate])
  return text.slice(0, shown)
}

function Bubble({ message, fresh }: { message: Message; fresh: boolean }) {
  const mine = message.role === 'user'
  const text = useReveal(message.text, fresh && !mine)
  return (
    <div
      className={cn(
        'flex',
        mine ? 'justify-end' : 'justify-start',
        fresh && 'chat-in',
      )}
    >
      <div
        className={cn(
          'max-w-[88%] min-w-0 rounded-[18px] px-3.5 py-2.5',
          mine
            ? 'rounded-br-[6px] bg-brand-text text-[15px] leading-relaxed break-words whitespace-pre-wrap text-brand-deck'
            : 'rounded-bl-[6px] bg-brand-surface text-brand-text',
        )}
      >
        {mine ? message.text : <ChatMarkdown text={text} />}
      </div>
    </div>
  )
}

/** A diff (lines starting "- " / "+ ") gets red / green rows; anything else is plain. */
function ToolBody({ text }: { text: string }) {
  const lines = text.split('\n')
  const isDiff = lines.some((l) => l.startsWith('- ') || l.startsWith('+ '))
  return (
    <pre className="max-h-72 overflow-auto rounded-[8px] bg-brand-deck py-1.5 font-mono text-[11.5px] leading-snug">
      {lines.map((line, index) => (
        <div
          key={index}
          className={cn(
            'px-2 whitespace-pre',
            isDiff &&
              line.startsWith('- ') &&
              'bg-brand-error/10 text-brand-error',
            isDiff &&
              line.startsWith('+ ') &&
              'bg-brand-done/10 text-brand-done',
          )}
        >
          {line || ' '}
        </div>
      ))}
    </pre>
  )
}

function ToolRow({ tool }: { tool: Message }) {
  const { t } = useLingui()
  if (!tool.body && !tool.result)
    return (
      <p className="truncate px-1 font-mono text-[12px] text-brand-label">
        {tool.text}
      </p>
    )
  return (
    <details className="group/tool rounded-[8px]">
      <summary className="flex cursor-pointer list-none items-center gap-1 truncate px-1 font-mono text-[12px] text-brand-muted">
        <span aria-hidden className="transition group-open/tool:rotate-90">
          ›
        </span>
        <span className="truncate">{tool.text}</span>
      </summary>
      <div className="grid gap-1.5 py-1.5 pl-3">
        {tool.body ? <ToolBody text={tool.body} /> : null}
        {tool.result ? (
          <div className="grid gap-0.5">
            <span className="text-[11px] text-brand-label">{t`Result`}</span>
            <ToolBody text={tool.result} />
          </div>
        ) : null}
      </div>
    </details>
  )
}

function ToolGroup({
  tools,
  fresh,
}: {
  tools: Array<Message>
  fresh: boolean
}) {
  const { t } = useLingui()
  const count = tools.length
  return (
    <details className={cn('group px-1', fresh && 'chat-in')}>
      <summary className="cursor-pointer list-none py-1 text-[12px] text-brand-label">
        {t`Used ${count} tools`}{' '}
        <span
          aria-hidden
          className="inline-block transition group-open:rotate-90"
        >
          ›
        </span>
      </summary>
      <div className="grid gap-1 pt-1">
        {tools.map((tool, index) => (
          <ToolRow key={index} tool={tool} />
        ))}
      </div>
    </details>
  )
}

type Item =
  | { kind: 'message'; message: Message; index: number }
  | { kind: 'tools'; tools: Array<Message>; index: number }

/** Consecutive tool calls collapse into one expandable line. */
function group(messages: Array<Message>) {
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
      <div className="flex gap-1 rounded-[18px] rounded-bl-[6px] bg-brand-surface px-3.5 py-3">
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
}: {
  messages: Array<Message>
  /** absolute index of messages[0] in the whole transcript (pagination) */
  start: number
  busy: boolean
}) {
  // messages present when the page opened render still; later ones animate.
  // Absolute indices, so loading earlier messages neither re-keys nor animates.
  const baseline = useRef<number | null>(null)
  if (baseline.current === null && messages.length > 0)
    baseline.current = start + messages.length
  const isFresh = (index: number) =>
    baseline.current !== null && start + index >= baseline.current
  return (
    <>
      {group(messages).map((item) =>
        item.kind === 'tools' ? (
          <ToolGroup
            key={`t${start + item.index}`}
            tools={item.tools}
            fresh={isFresh(item.index)}
          />
        ) : (
          <Bubble
            key={`m${start + item.index}`}
            message={item.message}
            fresh={isFresh(item.index)}
          />
        ),
      )}
      {busy ? <Typing /> : null}
    </>
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
          className="chat-in ml-auto max-w-[88%] truncate rounded-[14px] border border-dashed border-brand-edge px-3 py-1.5 text-[14px] text-brand-muted"
        >
          {item.text}
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
  return pending.filter(
    (item) =>
      Date.now() - item.at < 60_000 && !users.includes(item.text.trim()),
  )
}
