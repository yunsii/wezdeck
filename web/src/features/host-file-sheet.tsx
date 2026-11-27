// Host file / plan / artifact reader sheet backed by `session.file`.
// Supports Markdown (with TOC + lazy Mermaid + clickable nested file:// links)
// and Shiki-highlighted source code with `#L10-L20` line highlighting.
import { useLingui } from '@lingui/react/macro'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowLeft,
  Check,
  Copy,
  FileCode2,
  FileText,
  List,
  MessageSquarePlus,
  RefreshCw,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import { Disclosure } from '#/components/ui/disclosure'
import { Sheet } from '#/components/ui/sheet'
import { trace } from '#/lib/client-trace'
import { copyText } from '#/lib/clipboard'
import { highlightLines, langOf } from '#/lib/highlight'
import type { Token } from '#/lib/highlight'
import { extractMarkdownHeadings, formatLineRange } from '#/lib/host-file-link'
import { hostRead } from '#/lib/runtime-client'
import { cn } from '#/lib/utils'
import { ChatMarkdown } from './chat-markdown'
import { HostFileContext } from './host-file-context'
import type { OpenHostFileArgs } from './host-file-context'

type SessionFileResponse = {
  v: number
  ok: boolean
  path: string
  rel_path?: string
  name: string
  kind: 'markdown' | 'code' | 'text'
  lang?: string
  content: string
  size: number
  total_lines: number
  truncated?: boolean
  redacted?: boolean
  line_start?: number
  line_end?: number
  mtime?: number
}

function useCodeTokens(content: string, lang: string | null) {
  const [tokens, setTokens] = useState<Array<Array<Token>> | null>(null)
  useEffect(() => {
    if (!lang || !content) {
      setTokens(null)
      return
    }
    let live = true
    void highlightLines(content.split('\n'), lang).then((res) => {
      if (live) setTokens(res)
    })
    return () => {
      live = false
    }
  }, [content, lang])
  return tokens
}

function CodeFileBody({
  content,
  path,
  langHint,
  lineStart,
  lineEnd,
}: {
  content: string
  path: string
  langHint?: string
  lineStart?: number
  lineEnd?: number
}) {
  const lines = useMemo(() => content.split('\n'), [content])
  const lang = langHint || langOf(path)
  const tokens = useCodeTokens(content, lang)
  const targetRef = useRef<HTMLDivElement>(null)
  const rangeEnd = lineStart ? Math.max(lineStart, lineEnd ?? lineStart) : 0
  const numWidth = String(lines.length).length

  useEffect(() => {
    if (!lineStart || !targetRef.current) return
    targetRef.current.scrollIntoView({ block: 'center', behavior: 'instant' })
  }, [lineStart, path, content])

  return (
    <pre
      data-testid="host-file-code"
      data-lang={lang ?? undefined}
      className="overflow-x-auto rounded-xl bg-brand-surface py-2 font-mono text-meta leading-snug"
    >
      {lines.map((raw, i) => {
        const no = i + 1
        const hit = Boolean(lineStart && no >= lineStart && no <= rangeEnd)
        const lineTokens = tokens?.[i]
        return (
          <div
            key={no}
            ref={no === lineStart ? targetRef : undefined}
            data-line={no}
            data-highlighted={hit ? 'true' : undefined}
            className={cn('flex min-w-0 px-2', hit && 'bg-brand-running/15')}
          >
            <span
              aria-hidden
              style={{ width: `${numWidth + 1}ch` }}
              className={cn(
                'shrink-0 pr-2 text-right tabular-nums select-none',
                hit ? 'font-medium text-brand-running' : 'text-brand-label/70',
              )}
            >
              {no}
            </span>
            <span className="min-w-0 flex-1 whitespace-pre">
              {lineTokens
                ? lineTokens.map((tok, ti) => (
                    <span key={ti} className="code-token" style={tok.style}>
                      {tok.content}
                    </span>
                  ))
                : raw || ' '}
            </span>
          </div>
        )
      })}
    </pre>
  )
}

function MarkdownFileBody({ content }: { content: string }) {
  const { t } = useLingui()
  const containerRef = useRef<HTMLDivElement>(null)
  const headings = useMemo(() => extractMarkdownHeadings(content), [content])

  const jumpTo = (text: string) => {
    const root = containerRef.current
    if (!root) return
    const nodes = root.querySelectorAll('h3, h4')
    for (const node of nodes) {
      if ((node.textContent || '').trim() === text) {
        node.scrollIntoView({ block: 'start', behavior: 'smooth' })
        return
      }
    }
  }

  return (
    <div
      ref={containerRef}
      data-testid="host-file-markdown"
      className="grid gap-3"
    >
      {headings.length >= 2 ? (
        <Disclosure
          defaultOpen={false}
          triggerClassName="rounded-xl bg-brand-surface px-3 py-2 text-caption font-medium text-brand-text"
          panelClassName="pt-1.5"
          title={
            <span className="inline-flex items-center gap-1.5">
              <List size={14} aria-hidden className="text-brand-muted" />
              <span>{t`Contents`}</span>
              <span className="font-mono text-meta font-normal text-brand-label tabular-nums">
                {headings.length}
              </span>
            </span>
          }
        >
          <ul className="grid gap-0.5 rounded-xl bg-brand-surface p-2">
            {headings.map((h) => (
              <li key={`${h.index}-${h.text}`}>
                <Button
                  variant="plain"
                  size="none"
                  type="button"
                  onClick={() => jumpTo(h.text)}
                  className={cn(
                    'block w-full truncate rounded-lg px-2 py-1.5 text-left text-caption text-brand-muted hover:bg-brand-soft hover:text-brand-text',
                    h.level === 3 && 'pl-5 text-meta',
                  )}
                >
                  {h.text}
                </Button>
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
      <div className="rounded-xl bg-brand-surface px-4 py-3 text-brand-text">
        <ChatMarkdown text={content} />
      </div>
    </div>
  )
}

function FileViewerSheet({
  sessionId,
  stack,
  onBack,
  onClose,
  onQuote,
}: {
  sessionId: string
  stack: Array<OpenHostFileArgs>
  onBack: () => void
  onClose: () => void
  onQuote?: (text: string) => void
}) {
  const { t } = useLingui()
  const current = stack.at(-1) ?? null
  const [copied, setCopied] = useState<'none' | 'content' | 'path'>('none')

  const fileQuery = useQuery({
    queryKey: [
      'remote',
      'session.file',
      sessionId,
      current?.path ?? '',
      current?.lineStart ?? 0,
      current?.lineEnd ?? 0,
    ],
    enabled: Boolean(sessionId && current?.path),
    staleTime: 5_000,
    retry: false,
    queryFn: async () =>
      (await hostRead('session.file', {
        id: sessionId,
        path: current?.path,
        ...(current?.lineStart ? { line_start: current.lineStart } : {}),
        ...(current?.lineEnd ? { line_end: current.lineEnd } : {}),
      })) as SessionFileResponse,
  })

  const data = fileQuery.data
  useEffect(() => {
    if (!data) return
    trace('host-file-open', {
      id: sessionId,
      kind: data.kind,
      bytes: data.content.length,
      truncated: Boolean(data.truncated),
      redacted: Boolean(data.redacted),
    })
  }, [sessionId, data])

  const displayName =
    data?.name ||
    current?.label ||
    current?.path.split('/').at(-1) ||
    t`Document`
  const subtitle = data?.rel_path || data?.path || current?.path || ''
  const range = formatLineRange(
    data?.line_start ?? current?.lineStart,
    data?.line_end ?? current?.lineEnd,
  )

  const copyValue = (kind: 'content' | 'path', value: string) => {
    void copyText(value).then(() => {
      setCopied(kind)
      toast(kind === 'content' ? t`Copied document` : t`Copied path`)
      setTimeout(() => setCopied('none'), 1_500)
    })
  }

  return (
    <Sheet
      open={Boolean(current)}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      title={displayName}
      testId="host-file-sheet"
      className="md:max-w-4xl"
    >
      <div className="grid gap-3 px-3 pb-4">
        <div className="flex flex-wrap items-center gap-1.5 rounded-xl bg-brand-surface px-3 py-2">
          {stack.length > 1 ? (
            <Button
              variant="ghost"
              size="none"
              type="button"
              onClick={onBack}
              className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-caption text-brand-text"
            >
              <ArrowLeft size={14} aria-hidden />
              <span>{t`Back`}</span>
            </Button>
          ) : null}
          <span className="inline-flex min-w-0 flex-1 items-center gap-1.5 font-mono text-meta text-brand-muted">
            {data?.kind === 'code' ? (
              <FileCode2 size={14} aria-hidden className="shrink-0" />
            ) : (
              <FileText size={14} aria-hidden className="shrink-0" />
            )}
            <span className="truncate" title={subtitle}>
              {subtitle}
            </span>
            {range ? (
              <span className="shrink-0 rounded-md bg-brand-deck px-1.5 py-0.5 text-brand-running">
                {range}
              </span>
            ) : null}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="none"
              type="button"
              aria-label={t`Refresh`}
              title={t`Refresh`}
              disabled={fileQuery.isFetching}
              onClick={() => void fileQuery.refetch()}
              className="inline-flex size-8 items-center justify-center rounded-lg text-brand-muted"
            >
              <RefreshCw
                size={14}
                aria-hidden
                className={cn(fileQuery.isFetching && 'animate-spin')}
              />
            </Button>
            {data ? (
              <>
                <Button
                  variant="ghost"
                  size="none"
                  type="button"
                  onClick={() => copyValue('path', data.path)}
                  className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-meta text-brand-muted"
                >
                  {copied === 'path' ? (
                    <Check size={13} className="text-brand-done" aria-hidden />
                  ) : (
                    <Copy size={13} aria-hidden />
                  )}
                  <span>{t`Path`}</span>
                </Button>
                <Button
                  variant="ghost"
                  size="none"
                  type="button"
                  onClick={() => copyValue('content', data.content)}
                  className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-meta text-brand-muted"
                >
                  {copied === 'content' ? (
                    <Check size={13} className="text-brand-done" aria-hidden />
                  ) : (
                    <Copy size={13} aria-hidden />
                  )}
                  <span>{t`Copy`}</span>
                </Button>
              </>
            ) : null}
            {data && onQuote ? (
              <Button
                variant="solid"
                size="none"
                type="button"
                data-testid="host-file-quote"
                onClick={() => {
                  const ref = range
                    ? `${data.rel_path || data.name} (${range})`
                    : data.rel_path || data.name
                  onQuote(t`Regarding ${ref}: `)
                  onClose()
                }}
                className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2.5 text-meta"
              >
                <MessageSquarePlus size={13} aria-hidden />
                <span>{t`Reply`}</span>
              </Button>
            ) : null}
          </div>
        </div>

        {data?.truncated || data?.redacted ? (
          <p
            role="status"
            className="rounded-xl bg-brand-waiting/10 px-3 py-2 text-meta text-brand-text"
          >
            {data.truncated ? t`Showing the first 256 KB of this file.` : null}
            {data.truncated && data.redacted ? ' ' : null}
            {data.redacted
              ? t`Sensitive tokens were redacted before leaving the host.`
              : null}
          </p>
        ) : null}

        {fileQuery.isPending ? (
          <p className="px-2 py-8 text-center text-caption text-brand-muted">
            {t`Loading…`}
          </p>
        ) : fileQuery.isError ? (
          <p
            role="alert"
            data-testid="host-file-error"
            className="rounded-xl bg-brand-error/10 px-3 py-2.5 text-caption text-brand-error"
          >
            {fileQuery.error instanceof Error
              ? fileQuery.error.message
              : String(fileQuery.error)}
          </p>
        ) : data ? (
          data.kind === 'markdown' ? (
            <MarkdownFileBody content={data.content} />
          ) : (
            <CodeFileBody
              content={data.content}
              path={data.path}
              langHint={data.lang}
              lineStart={data.line_start}
              lineEnd={data.line_end}
            />
          )
        ) : null}
      </div>
    </Sheet>
  )
}

export function HostFileProvider({
  sessionId,
  onQuote,
  children,
}: {
  sessionId: string
  onQuote?: (text: string) => void
  children: ReactNode
}) {
  const [stack, setStack] = useState<Array<OpenHostFileArgs>>([])

  // Clear open viewer when switching sessions
  useEffect(() => {
    setStack([])
  }, [sessionId])

  const openFile = useCallback((target: OpenHostFileArgs) => {
    setStack((prev) => {
      const top = prev.at(-1)
      if (
        top &&
        top.path === target.path &&
        top.lineStart === target.lineStart &&
        top.lineEnd === target.lineEnd
      )
        return prev
      return [...prev, target]
    })
  }, [])

  const value = useMemo(() => ({ sessionId, openFile }), [sessionId, openFile])

  return (
    <HostFileContext.Provider value={value}>
      {children}
      <FileViewerSheet
        sessionId={sessionId}
        stack={stack}
        onBack={() => setStack((prev) => prev.slice(0, -1))}
        onClose={() => setStack([])}
        onQuote={onQuote}
      />
    </HostFileContext.Provider>
  )
}
