// The conversation on a phone: Markdown replies, one collapsed line per run
// of tool calls, and motion only where something just happened — messages
// that arrive after the page opened slide in and a new reply unfolds over at
// most half a second; nothing animates under prefers-reduced-motion.
import { useLingui } from '@lingui/react/macro'
import { useCallback, useEffect, useRef, useState } from 'react'

import { cn } from '#/lib/utils'
import { ChatMarkdown } from './chat-markdown'

export type Message = {
  role: 'user' | 'assistant' | 'tool'
  text: string
  ts?: string
  tool?: string
  body?: string
  result?: string
  file?: string
  added?: number
  removed?: number
}

export type Pending = { text: string; at: number }

const reducedMotion = () =>
  typeof matchMedia !== 'undefined' &&
  matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Stream a just-arrived reply in at a reading pace (about 300 chars/s, at
 * least 0.4 s and at most 3 s for the whole message), like the agent typing
 * it; Streamdown renders the half-written Markdown in between.
 */
function useStream(text: string, active: boolean, onDone?: () => void) {
  const [shown, setShown] = useState(active ? 0 : text.length)
  const done = useRef(onDone)
  done.current = onDone
  useEffect(() => {
    if (!active || reducedMotion() || document.hidden) {
      setShown(text.length)
      done.current?.()
      return
    }
    const started = performance.now()
    const total = Math.min(3000, Math.max(400, (text.length / 300) * 1000))
    let frame = 0
    const tick = (now: number) => {
      const progress = Math.min(1, (now - started) / total)
      setShown(Math.ceil(text.length * progress))
      if (progress < 1) frame = requestAnimationFrame(tick)
      else done.current?.()
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [text, active])
  return {
    text: text.slice(0, shown),
    streaming: active && shown < text.length,
  }
}

function Bubble({
  message,
  fresh,
  stream,
  onShown,
}: {
  message: Message
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
        {mine ? (
          message.text
        ) : (
          <ChatMarkdown text={live.text} streaming={live.streaming} />
        )}
      </div>
    </div>
  )
}

/** A diff (lines starting "- " / "+ ") gets red / green rows; anything else is plain. */
function ToolBody({ text }: { text: string }) {
  const lines = text.split('\n')
  const isDiff = lines.some((l) => l.startsWith('- ') || l.startsWith('+ '))
  return (
    <pre className="max-h-72 max-w-full min-w-0 overflow-auto rounded-[8px] bg-brand-deck py-1.5 font-mono text-[11.5px] leading-snug">
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
    <details className="group/tool min-w-0 rounded-[8px]">
      <summary className="flex cursor-pointer list-none items-center gap-1 truncate px-1 font-mono text-[12px] text-brand-muted">
        <span aria-hidden className="transition group-open/tool:rotate-90">
          ›
        </span>
        <span className="truncate">{tool.text}</span>
      </summary>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5 py-1.5 pl-3">
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
  stream,
  onShown,
}: {
  tools: Array<Message>
  fresh: boolean
  stream: boolean
  onShown?: () => void
}) {
  const { t } = useLingui()
  const count = tools.length
  const { files, edited, added, removed, commands, reads } = toolDigest(tools)
  const summaryParts = [
    edited ? t`changed ${edited} files +${added} −${removed}` : '',
    commands ? t`ran ${commands} commands` : '',
    reads ? t`read ${reads} files` : '',
    t`${count} tool calls`,
  ].filter(Boolean)
  const shown = useRef(onShown)
  shown.current = onShown
  useEffect(() => {
    if (!stream) return
    const timer = setTimeout(() => shown.current?.(), 160)
    return () => clearTimeout(timer)
  }, [stream])
  return (
    <details className={cn('group min-w-0 px-1', fresh && 'chat-in')}>
      <summary className="grid min-w-0 cursor-pointer list-none gap-1 py-1 text-[12px] text-brand-label">
        <span className="flex flex-wrap items-center gap-x-1.5">
          {summaryParts.join('，')}
          <span
            aria-hidden
            className="inline-block transition group-open:rotate-90"
          >
            ›
          </span>
        </span>
        {files.length ? (
          <span className="flex min-w-0 flex-wrap gap-1">
            {files.map((file) => (
              <span
                key={file.path}
                className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-full bg-brand-surface px-2 py-0.5 font-mono text-[11px]"
              >
                <span className="truncate text-brand-muted">{file.name}</span>
                {file.added ? (
                  <span className="text-brand-done">+{file.added}</span>
                ) : null}
                {file.removed ? (
                  <span className="text-brand-error">−{file.removed}</span>
                ) : null}
              </span>
            ))}
          </span>
        ) : null}
      </summary>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 pt-1">
        {tools.map((tool, index) => (
          <ToolRow key={index} tool={tool} />
        ))}
      </div>
    </details>
  )
}

/** What a run of tool calls did, readable without expanding it. */
function toolDigest(tools: Array<Message>) {
  const byFile = new Map<
    string,
    { path: string; name: string; added: number; removed: number }
  >()
  let commands = 0
  let reads = 0
  for (const tool of tools) {
    if (tool.tool === 'Bash') commands++
    else if (tool.tool === 'Read') reads++
    else if (
      tool.file &&
      ['Edit', 'MultiEdit', 'Write'].includes(tool.tool ?? '')
    ) {
      const entry = byFile.get(tool.file) ?? {
        path: tool.file,
        name: tool.file.split('/').at(-1) ?? tool.file,
        added: 0,
        removed: 0,
      }
      entry.added += tool.added ?? 0
      entry.removed += tool.removed ?? 0
      byFile.set(tool.file, entry)
    }
  }
  const files = [...byFile.values()]
  return {
    files,
    edited: files.length,
    added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0),
    commands,
    reads,
  }
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
  const effective =
    cursor === null ? (baseline.current ?? end) : Math.max(cursor, end - 8)
  const advance = useCallback(
    (to: number) => setCursor((current) => Math.max(current ?? 0, to)),
    [],
  )
  const isFresh = (index: number) =>
    baseline.current !== null && start + index >= baseline.current
  return (
    <>
      {group(messages).map((item) => {
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
              onShown={
                stream ? () => advance(at + item.tools.length) : undefined
              }
            />
          )
        return (
          <Bubble
            key={`m${at}`}
            message={item.message}
            fresh={isFresh(item.index)}
            stream={stream}
            onShown={stream ? () => advance(at + 1) : undefined}
          />
        )
      })}
      {busy && effective >= end ? <Typing /> : null}
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
