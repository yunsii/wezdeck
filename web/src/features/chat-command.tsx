// A slash command in the conversation (/model, /compact, /resume …) and what
// it printed — native/wezdeck-wsl/claude_command.go, kind "slash". A quiet
// row like the compaction divider, not a bubble: nobody said it to the
// agent. Long output folds.
import { useLingui } from '@lingui/react/macro'
import { Radio, SquareSlash, SquareTerminal } from 'lucide-react'
import { useEffect } from 'react'

import { Disclosure } from '#/components/ui/disclosure'
import { cn } from '#/lib/utils'
import type { Message } from './chat-thread'

export function SlashCommandRow({
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
  const command = message.text || t`Command output`
  const output = message.body ?? ''
  const head = (
    <span className="flex min-w-0 items-center gap-1.5 text-caption text-brand-label">
      <SquareSlash size={13} aria-hidden className="shrink-0" />
      <span className="truncate font-mono text-brand-muted">{command}</span>
    </span>
  )
  const short = output && !output.includes('\n') && output.length <= 120
  return (
    <div className="grid gap-1 py-0.5" data-testid="slash-command">
      {!output ? (
        head
      ) : short ? (
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          {head}
          <span className="text-caption text-brand-muted">{output}</span>
        </span>
      ) : (
        <Disclosure chevron={false} title={head} triggerClassName="w-auto">
          <pre className="mt-1 max-h-72 overflow-auto rounded-xl bg-brand-surface px-3 py-2 font-mono text-meta leading-snug whitespace-pre-wrap text-brand-muted">
            {output}
          </pre>
        </Disclosure>
      )}
    </div>
  )
}

/**
 * A background task's notification where it arrived, as the terminal prints
 * it (native agent_claude.go taskNotification, kind "task"): the summary —
 * `Monitor event: "…"`, `Monitor "…" stream ended`, `Background command "…"
 * completed (exit code 0)` — and a Monitor event's lines under it. A quiet
 * row like a slash command; a long event folds. The same text also lands on
 * the call that started the task.
 */
/**
 * Claude API Error (isApiErrorMessage): same text the TUI prints as a
 * system line. kind "error" from native/wezdeck-wsl/agent_claude.go.
 */
export function ApiErrorRow({
  message,
  onShown,
}: {
  message: Message
  onShown?: () => void
}) {
  const { t } = useLingui()
  useEffect(() => {
    onShown?.()
  }, [onShown])
  const text = message.text || t`API error`
  const long = text.includes('\n') || text.length > 160
  return (
    <div
      className="grid gap-1 rounded-xl border border-brand-error/30 bg-brand-error/10 px-3 py-2"
      data-testid="api-error"
      data-role="system"
    >
      <span className="text-caption font-medium text-brand-error">
        {t`API error`}
      </span>
      {long ? (
        <Disclosure
          chevron={false}
          title={
            <span className="truncate font-mono text-caption text-brand-error">
              {text.split('\n')[0]}
            </span>
          }
          triggerClassName="w-auto text-left"
        >
          <pre className="mt-1 max-h-72 overflow-auto font-mono text-meta leading-snug whitespace-pre-wrap text-brand-error/90">
            {text}
          </pre>
        </Disclosure>
      ) : (
        <pre className="font-mono text-meta leading-snug whitespace-pre-wrap text-brand-error/90">
          {text}
        </pre>
      )}
    </div>
  )
}

export function TaskEventRow({
  message,
  onShown,
}: {
  message: Message
  onShown?: () => void
}) {
  useEffect(() => {
    onShown?.()
  }, [onShown])
  const summary = message.text
  const event = message.body ?? ''
  const monitor = summary.startsWith('Monitor')
  const ended = /stream ended|completed|failed|killed/.test(summary)
  const head = (
    <span className="flex min-w-0 items-center gap-1.5 text-caption text-brand-label">
      {monitor ? (
        <Radio size={13} aria-hidden className="shrink-0" />
      ) : (
        <SquareTerminal size={13} aria-hidden className="shrink-0" />
      )}
      <span
        className={cn(
          'truncate',
          ended ? 'text-brand-muted' : 'text-brand-text',
        )}
      >
        {summary}
      </span>
    </span>
  )
  const lines = event.split('\n')
  const short = event && lines.length <= 3 && event.length <= 240
  return (
    <div className="grid gap-1 py-0.5" data-testid="task-event">
      {!event ? (
        head
      ) : short ? (
        <>
          {head}
          <pre className="pl-5 font-mono text-meta leading-snug whitespace-pre-wrap text-brand-muted">
            {event}
          </pre>
        </>
      ) : (
        <Disclosure chevron={false} title={head} triggerClassName="w-auto">
          <pre className="mt-1 max-h-72 overflow-auto rounded-xl bg-brand-surface px-3 py-2 font-mono text-meta leading-snug whitespace-pre-wrap text-brand-muted">
            {event}
          </pre>
        </Disclosure>
      )}
    </div>
  )
}
