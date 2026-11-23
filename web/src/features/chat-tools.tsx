// Runs of tool calls in the conversation: one collapsed line saying what the
// run did (files changed with +/- lines, commands run, files read), each call
// expandable to its diff / preview / command and result. The newest run while
// the agent works is open, shows its last calls and a light per call.
import { useLingui } from '@lingui/react/macro'
import { memo, useEffect, useRef, useState } from 'react'

import { Led } from '#/components/deck/led'
import { cn } from '#/lib/utils'
import { TranscriptImages } from './chat-images'
import type { Message } from './chat-thread'
import { Disclosure } from '#/components/ui/disclosure'
import { ToolBody } from './chat-diff'
import { Button } from '#/components/ui/button'

/** While a run is live: a breathing light for the call in flight, a check once it returned. */
/**
 * Icons in a tool row sit in a box one text line tall (LINE), so they stay
 * centred on the first line however many lines the description wraps to.
 */
const LINE = 'inline-flex h-5 shrink-0 items-center'

/** Claude Code tools that Ctrl+B moves to the background while they run. */
const BACKGROUNDABLE = new Set(['Bash', 'Agent', 'Task'])

/**
 * A call Ctrl+B can move to the background: still out, a Bash command or a
 * subagent, and not one that asked to run there already.
 */
export const canBackground = (tool: Message) =>
  tool.role === 'tool' &&
  Boolean(tool.pending) &&
  !tool.background &&
  BACKGROUNDABLE.has(tool.tool ?? '')

/**
 * 转到后台 on the running call itself: Claude Code's Ctrl+B — the command or
 * subagent keeps going in the background and the agent carries on.
 */
function ToBackground({ onClick }: { onClick: () => void }) {
  const { t } = useLingui()
  return (
    <Button
      variant="plain"
      type="button"
      data-write
      data-testid="to-background"
      title={t`Send Ctrl+B: the running command keeps going in the background and the agent carries on`}
      onClick={onClick}
      // the row is h-5 (leading-5) and its panel clips: stay within it
      className="inline-flex h-5 shrink-0 items-center rounded-full bg-brand-surface px-2 text-meta leading-none text-brand-text"
    >
      {t`Run in background`}
    </Button>
  )
}

/**
 * The host writes "<tool name> <target>" (toolSummary); show the two parts
 * apart — name quiet, target in text colour — split by a hairline.
 */
function splitTool(tool: Message) {
  const name = tool.tool ?? ''
  const prefix = `${name} `
  return name && tool.text.startsWith(prefix)
    ? { name, target: tool.text.slice(prefix.length) }
    : { name, target: '' }
}

function ToolStatus({ status }: { status?: 'running' | 'done' }) {
  const { t } = useLingui()
  if (!status) return null
  return (
    <span className={LINE}>
      {status === 'running' ? (
        <Led
          tone="running"
          size={9}
          className="led-running"
          label={t`Running`}
        />
      ) : (
        <Led tone="done" size={9} label={t`Done`} />
      )}
    </span>
  )
}

function ToolRow({
  tool,
  status,
  onBackground,
}: {
  tool: Message
  status?: 'running' | 'done'
  /** this running call can go to the background: 转到后台 at the row's end */
  onBackground?: () => void
}) {
  const { t } = useLingui()
  const details = Boolean(tool.body || tool.result || tool.images?.length)
  const { name, target } = splitTool(tool)
  // images load only once the call is opened (a run can hold many screenshots)
  const [opened, setOpened] = useState(false)
  return (
    <Disclosure
      className="min-w-0 rounded-lg"
      onOpenChange={setOpened}
      chevron={false}
      // 转到后台 on this call's own line, beside its trigger
      aside={onBackground ? <ToBackground onClick={onBackground} /> : undefined}
      triggerClassName="flex min-w-0 items-start gap-1 px-1 font-mono text-meta leading-5 text-brand-muted"
      title={
        <>
          <span aria-hidden className={LINE}>
            <span className="transition group-data-[panel-open]:rotate-90">
              ›
            </span>
          </span>
          <ToolStatus status={status} />
          {target ? (
            <>
              <span className="shrink-0 text-brand-label">{name}</span>
              <span aria-hidden className={cn(LINE, 'px-1')}>
                <span className="h-3.5 w-px bg-brand-label/50" />
              </span>
              <span className="min-w-0 truncate text-brand-text group-data-[panel-open]:break-all group-data-[panel-open]:whitespace-pre-wrap">
                {target}
              </span>
            </>
          ) : (
            <span className="min-w-0 truncate group-data-[panel-open]:break-all group-data-[panel-open]:whitespace-pre-wrap">
              {tool.text}
            </span>
          )}
        </>
      }
    >
      {details ? (
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5 py-1.5 pl-3">
          {tool.body ? <ToolBody text={tool.body} file={tool.file} /> : null}
          {tool.result ? (
            <div className="grid gap-0.5">
              <span className="text-meta text-brand-label">{t`Result`}</span>
              <ToolBody text={tool.result} />
            </div>
          ) : null}
          {opened ? <TranscriptImages refs={tool.images} /> : null}
        </div>
      ) : null}
    </Disclosure>
  )
}

/** a live run shows only its newest calls */
const LIVE_ROWS = 3

function ToolGroupView({
  tools,
  fresh,
  stream,
  live,
  onBackground,
  onShown,
}: {
  tools: Array<Message>
  fresh: boolean
  stream: boolean
  /** the newest run while the agent works: open, newest calls, status lights */
  live: boolean
  /** Claude, writable, this run live: Ctrl+B for its running foreground call */
  onBackground?: () => void
  onShown?: () => void
}) {
  const { t } = useLingui()
  // open while live, collapsed once the run is over (a tap still opens it)
  const [opened, setOpened] = useState(false)
  const open = live || opened
  const rows = live ? tools.slice(-LIVE_ROWS) : tools
  const earlier = tools.length - rows.length
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
    <Disclosure
      open={open}
      onOpenChange={(next) => {
        if (!live) setOpened(next)
      }}
      className={cn('min-w-0 px-1', fresh && 'chat-in')}
      chevron={false}
      triggerClassName="grid min-w-0 gap-1 py-1 text-meta text-brand-label"
      title={
        <>
          <span className="flex flex-wrap items-center gap-x-1.5">
            {summaryParts.join('，')}
            <span
              aria-hidden
              className="inline-block transition group-data-[panel-open]:rotate-90"
            >
              ›
            </span>
          </span>
          {files.length ? (
            <span className="flex min-w-0 flex-wrap gap-1">
              {files.map((file) => (
                <span
                  key={file.path}
                  className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-full bg-brand-surface px-2 py-0.5 font-mono text-meta"
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
        </>
      }
    >
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 pt-1">
        {earlier ? (
          <p className="px-1 text-meta text-brand-label">
            {t`${earlier} earlier calls`}
          </p>
        ) : null}
        {rows.map((tool, index) => (
          <ToolRow
            key={earlier + index}
            tool={tool}
            status={live ? (tool.pending ? 'running' : 'done') : undefined}
            onBackground={
              live && index === rows.length - 1 && canBackground(tool)
                ? onBackground
                : undefined
            }
          />
        ))}
      </div>
    </Disclosure>
  )
}

/** What a run of tool calls did, readable without expanding it. */
/** Claude tool names, for hosts older than the shared `kind` field. */
const LEGACY_KINDS: Partial<Record<string, string>> = {
  Bash: 'command',
  Read: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'write',
}

/** The shared tool kind from the host's agent adapter (agent_adapter.go). */
const kindOf = (tool: Message) =>
  tool.kind ?? LEGACY_KINDS[tool.tool ?? ''] ?? 'other'

function toolDigest(tools: Array<Message>) {
  const byFile = new Map<
    string,
    { path: string; name: string; added: number; removed: number }
  >()
  let commands = 0
  let reads = 0
  for (const tool of tools) {
    const kind = kindOf(tool)
    if (kind === 'command') commands++
    else if (kind === 'read') reads++
    else if (tool.file && (kind === 'edit' || kind === 'write')) {
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

type ToolGroupProps = Parameters<typeof ToolGroupView>[0]

/**
 * A run re-renders only when one of its calls changed (a result came in):
 * the thread builds a new `tools` array on every poll, but merged messages
 * keep their identity (lib/session-cache), so compare the calls one by one.
 */
export const ToolGroup = memo(
  ToolGroupView,
  (a: ToolGroupProps, b: ToolGroupProps) =>
    a.fresh === b.fresh &&
    a.stream === b.stream &&
    a.live === b.live &&
    // the callback is rebuilt every render but always sends Ctrl+B to this
    // session: only whether it is offered matters
    Boolean(a.onBackground) === Boolean(b.onBackground) &&
    a.onShown === b.onShown &&
    a.tools.length === b.tools.length &&
    a.tools.every((tool, i) => tool === b.tools[i]),
)
