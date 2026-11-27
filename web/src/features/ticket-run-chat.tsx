// Renders a ticket's headless run execution using the unified `ChatThread`
// component (Markdown replies, collapsible tool groups, syntax-highlighted
// diffs, thinking rows) via `collab.run_chat`, with a multi-run pill switcher
// and on-demand access to raw launch details.
import { useLingui } from '@lingui/react/macro'
import { useQuery } from '@tanstack/react-query'
import { ChevronUp, Terminal } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Led } from '#/components/deck/led'
import { Button } from '#/components/ui/button'
import { Disclosure } from '#/components/ui/disclosure'
import { Sheet } from '#/components/ui/sheet'
import { Skeleton, SkeletonGroup } from '#/components/ui/skeleton'
import { hostRead } from '#/lib/runtime-client'
import type { CollabRunSummary } from '#/lib/runtime-contract'
import { cn } from '#/lib/utils'
import { ChatMarkdown } from './chat-markdown'
import { ChatThread } from './chat-thread'
import type { Message } from './chat-thread'
import { num, pct, secs, usd } from './console-collab-format'
import { RunDetail } from './console-collab-run'

/** Split machine-assembled worker prompt(s) at the start of a headless run out
 * of the conversation stream so they render folded as Markdown instead of a
 * raw dark user bubble wall. */
export function splitWorkerPrompt(messages: Array<Message>): {
  prompts: Array<Message>
  conversation: Array<Message>
} {
  const prompts: Array<Message> = []
  let idx = 0
  while (idx < messages.length) {
    const m = messages[idx]
    const looksLikeWorkerPrompt =
      m.role === 'user' &&
      (/^#\s+(Cross-repo ticket|AGENTS\.md|Ticket)\b/i.test(m.text.trim()) ||
        (m.text.length > 350 && /^#{1,3}\s/m.test(m.text)))
    if (!looksLikeWorkerPrompt) break
    prompts.push(m)
    idx += 1
  }
  return { prompts, conversation: messages.slice(idx) }
}

type CollabRunChatResponse = {
  v: number
  ok: boolean
  run: string
  ticket: string
  backend?: string
  model?: string
  phase?: string
  role?: string
  running: boolean
  source: string
  session_id?: string
  messages: Array<Message>
  total: number
  start: number
  span: string
}

function WorkerPromptDisclosure({ prompts }: { prompts: Array<Message> }) {
  const { t } = useLingui()
  if (prompts.length === 0) return null
  const promptCount = prompts.length
  return (
    <Disclosure
      data-testid="ticket-run-prompt-disclosure"
      defaultOpen={false}
      className="overflow-hidden rounded-xl border border-brand-edge bg-brand-surface"
      triggerClassName="min-h-10 px-3 text-caption font-medium text-brand-muted"
      title={t`Task prompt (${promptCount})`}
    >
      <div className="grid max-h-[60vh] gap-4 overflow-y-auto border-t border-brand-edge px-4 py-3 text-brand-text">
        {prompts.map((promptMsg, i) => (
          <ChatMarkdown
            key={`prompt-${i}`}
            text={promptMsg.text}
            variant="document"
            className="text-caption"
          />
        ))}
      </div>
    </Disclosure>
  )
}

export function TicketRunChat({
  ticketId,
  runs,
  liveRunIds,
  poll,
}: {
  ticketId: string
  runs: Array<CollabRunSummary>
  liveRunIds: Array<string>
  poll: number
}) {
  const { t } = useLingui()
  // Combine completed run summaries + any in-flight run IDs not yet in `runs`.
  const runIds = [
    ...runs.map((r) => r.run),
    ...liveRunIds.filter((rid) => !runs.some((r) => r.run === rid)),
  ]
  const defaultRun = runIds.at(-1) ?? ''
  const [selectedRun, setSelectedRun] = useState(defaultRun)
  const [limit, setLimit] = useState(80)
  const [detailsOpen, setDetailsOpen] = useState(false)

  useEffect(() => {
    setSelectedRun(defaultRun)
    setLimit(80)
  }, [ticketId, defaultRun])

  const activeRunId = runIds.includes(selectedRun) ? selectedRun : defaultRun
  const activeSummary = runs.find((r) => r.run === activeRunId)
  const isLive =
    liveRunIds.includes(activeRunId) ||
    (activeSummary != null && activeSummary.exit == null)

  const chat = useQuery({
    queryKey: ['remote', 'collab.run.chat', ticketId, activeRunId, limit],
    enabled: Boolean(activeRunId),
    refetchInterval: isLive ? poll : false,
    queryFn: async () =>
      (await hostRead('collab.run.chat', {
        run: activeRunId,
        ticket: ticketId,
        limit,
      })) as CollabRunChatResponse,
  })

  if (runIds.length === 0) return null

  const data = chat.data
  const messages = data?.messages ?? []
  const { prompts, conversation } = splitWorkerPrompt(messages)
  const shownCount = messages.length
  const start = data?.start ?? 0
  const total = data?.total ?? shownCount
  const hasMore = start > 0

  return (
    <section
      data-testid="ticket-run-chat"
      aria-label={t`Execution conversation`}
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-brand-edge bg-brand-surface px-3 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {runIds.length > 1 ? (
            runIds.map((rid) => {
              const summary = runs.find((r) => r.run === rid)
              const live =
                liveRunIds.includes(rid) ||
                (summary != null && summary.exit == null)
              const tone = live
                ? 'running'
                : summary?.exit === 0
                  ? 'done'
                  : 'error'
              const active = rid === activeRunId
              return (
                <Button
                  key={rid}
                  variant={active ? 'solid' : 'ghost'}
                  size="none"
                  type="button"
                  data-testid="ticket-run-pill"
                  data-run={rid}
                  onClick={() => {
                    setSelectedRun(rid)
                    setLimit(80)
                  }}
                  className={cn(
                    'inline-flex min-h-7 items-center gap-1.5 rounded-lg px-2 py-0.5 text-meta',
                    !active && 'text-brand-muted',
                  )}
                >
                  <Led tone={tone} size={8} />
                  <span>{summary?.phase ?? t`run`}</span>
                  <span className="font-mono opacity-80">{rid.slice(-6)}</span>
                </Button>
              )
            })
          ) : (
            <span className="inline-flex items-center gap-1.5 text-caption font-medium text-brand-text">
              <Led
                tone={
                  isLive
                    ? 'running'
                    : activeSummary?.exit === 0
                      ? 'done'
                      : 'error'
                }
                size={9}
              />
              <span>{activeSummary?.phase ?? data?.phase ?? t`Run`}</span>
              {data?.backend || activeSummary?.backend ? (
                <span className="font-mono text-meta font-normal text-brand-muted">
                  {data?.backend ?? activeSummary?.backend}
                </span>
              ) : null}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {activeSummary ? (
            <span className="hidden font-mono text-meta text-brand-label tabular-nums sm:inline">
              {num(activeSummary.turns)} {t`turns`} ·{' '}
              {pct(activeSummary.cache_hit_rate)} ·{' '}
              {usd(activeSummary.cost_usd)} · {secs(activeSummary.wall_ms)}
            </span>
          ) : null}
          <Button
            variant="ghost"
            size="none"
            type="button"
            data-testid="ticket-run-details-button"
            onClick={() => setDetailsOpen(true)}
            className="inline-flex min-h-7 items-center gap-1 rounded-lg px-2 text-meta text-brand-muted"
          >
            <Terminal size={13} aria-hidden />
            <span>{t`Run log`}</span>
          </Button>
        </div>
      </div>

      {hasMore ? (
        <div className="flex justify-center">
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => setLimit((prev) => prev + 120)}
            className="inline-flex items-center gap-1 text-meta text-brand-muted"
          >
            <ChevronUp size={14} aria-hidden />
            <span>{t`Load earlier (${start} more)`}</span>
          </Button>
        </div>
      ) : null}

      {chat.isPending ? (
        <div
          data-testid="ticket-run-chat-loading"
          className="rounded-xl border border-brand-edge bg-brand-surface p-4"
        >
          <SkeletonGroup className="grid gap-2.5">
            <Skeleton className="h-4 w-2/3 rounded" />
            <Skeleton className="h-16 w-full rounded-xl" />
            <Skeleton className="h-4 w-1/2 rounded" />
          </SkeletonGroup>
        </div>
      ) : chat.isError ? (
        <p
          role="alert"
          className="rounded-xl bg-brand-error/10 px-3 py-2 text-caption text-brand-error"
        >
          {chat.error instanceof Error
            ? chat.error.message
            : String(chat.error)}
        </p>
      ) : messages.length === 0 ? (
        <p className="rounded-xl border border-brand-edge bg-brand-surface px-4 py-6 text-center text-caption text-brand-muted">
          {isLive
            ? t`Waiting for worker output…`
            : t`No conversation messages recorded for this run.`}
        </p>
      ) : (
        <div className="grid min-w-0 gap-2.5">
          <WorkerPromptDisclosure prompts={prompts} />
          {conversation.length > 0 ? (
            <ChatThread
              key={`${ticketId}:${activeRunId}`}
              messages={conversation}
              start={start + prompts.length}
              busy={Boolean(data?.running || isLive)}
              status={data?.running || isLive ? 'running' : 'done'}
              sessionId={data?.session_id ?? ''}
            />
          ) : null}
          {total > shownCount ? (
            <p className="mt-1.5 text-center font-mono text-meta text-brand-label tabular-nums">
              {t`Showing ${shownCount} of ${total} items`}
            </p>
          ) : null}
        </div>
      )}

      <Sheet
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
        title={`${activeSummary?.phase ?? t`Run`} · ${activeRunId.slice(-6)}`}
        testId="ticket-run-sheet"
        className="md:max-w-3xl"
      >
        <div className="px-3 pb-4">
          {detailsOpen ? (
            <RunDetail run={activeRunId} poll={poll} defaultOpenTranscript />
          ) : null}
        </div>
      </Sheet>
    </section>
  )
}
