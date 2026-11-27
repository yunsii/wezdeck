// Fullscreen host file / plan / artifact reader backed by `session.file`.
// Supports Markdown (with sticky desktop TOC + lazy fit-width Mermaid + Shiki
// fenced blocks + clickable nested file:// links) and syntax-highlighted code
// with `#L10-L20` line highlighting.
import { useLingui } from '@lingui/react/macro'
import { useQuery } from '@tanstack/react-query'
import {
  Check,
  Copy,
  FileCode2,
  FileText,
  MessageSquarePlus,
  RefreshCw,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import { Sheet } from '#/components/ui/sheet'
import { trace } from '#/lib/client-trace'
import { copyText } from '#/lib/clipboard'
import { formatLineRange } from '#/lib/host-file-link'
import { hostRead } from '#/lib/runtime-client'
import {
  CodeFileBody,
  FileLoadingSkeleton,
  MarkdownFileBody,
} from './host-file-body'
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

function FileViewerActions({
  data,
  range,
  copied,
  isFetching,
  onRefresh,
  onCopy,
  onQuote,
  onClose,
}: {
  data?: SessionFileResponse
  range: string
  copied: 'none' | 'content' | 'path'
  isFetching: boolean
  onRefresh: () => void
  onCopy: (kind: 'content' | 'path', value: string) => void
  onQuote?: (text: string) => void
  onClose: () => void
}) {
  const { t } = useLingui()
  return (
    <div className="flex items-center gap-1">
      <Button
        variant="ghost"
        size="none"
        type="button"
        aria-label={t`Refresh`}
        title={t`Refresh`}
        disabled={isFetching}
        onClick={onRefresh}
        className="inline-flex size-8 items-center justify-center rounded-lg text-brand-muted"
      >
        {/* Static icon while fetching: animate-spin creates an ActiveTransformAnimation
            GPU layer right inside the modal title bar, causing the header text to
            flicker when the layer mounts and tears down on fetch completion. */}
        <RefreshCw size={14} aria-hidden />
      </Button>
      {data ? (
        <>
          <Button
            variant="ghost"
            size="none"
            type="button"
            aria-label={t`Copy path`}
            title={t`Copy path`}
            onClick={() => onCopy('path', data.path)}
            className="hidden min-h-8 items-center gap-1 rounded-lg px-2 text-meta text-brand-muted sm:inline-flex"
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
            aria-label={t`Copy document`}
            title={t`Copy document`}
            onClick={() => onCopy('content', data.content)}
            className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-meta text-brand-muted"
          >
            {copied === 'content' ? (
              <Check size={13} className="text-brand-done" aria-hidden />
            ) : (
              <Copy size={13} aria-hidden />
            )}
            <span className="hidden sm:inline">{t`Copy`}</span>
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
  const subtitleText = data?.rel_path || data?.path || current?.path || ''
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

  const headerSubtitle = (
    <div className="flex min-w-0 items-center gap-1.5 font-mono text-meta text-brand-muted">
      {data?.kind === 'code' ? (
        <FileCode2 size={13} aria-hidden className="shrink-0" />
      ) : (
        <FileText size={13} aria-hidden className="shrink-0" />
      )}
      <span className="truncate" title={subtitleText}>
        {subtitleText}
      </span>
      {range ? (
        <span className="shrink-0 rounded-md bg-brand-deck px-1.5 py-0.5 text-brand-running">
          {range}
        </span>
      ) : null}
    </div>
  )

  return (
    <Sheet
      open={Boolean(current)}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      fullscreen
      onBack={stack.length > 1 ? onBack : undefined}
      title={displayName}
      subtitle={headerSubtitle}
      actions={
        <FileViewerActions
          data={data}
          range={range}
          copied={copied}
          isFetching={fileQuery.isFetching}
          onRefresh={() => void fileQuery.refetch()}
          onCopy={copyValue}
          onQuote={onQuote}
          onClose={onClose}
        />
      }
      testId="host-file-sheet"
    >
      <div className="flex min-h-full w-full min-w-0 flex-col">
        {data?.truncated || data?.redacted ? (
          <div className="mx-auto w-full max-w-6xl px-3 pt-3 sm:px-6">
            <p
              role="status"
              className="rounded-xl bg-brand-waiting/10 px-3.5 py-2 text-meta text-brand-text"
            >
              {data.truncated
                ? t`Showing the first 256 KB of this file.`
                : null}
              {data.truncated && data.redacted ? ' ' : null}
              {data.redacted
                ? t`Sensitive tokens were redacted before leaving the host.`
                : null}
            </p>
          </div>
        ) : null}

        {fileQuery.isPending ? (
          <FileLoadingSkeleton />
        ) : fileQuery.isError ? (
          <div className="mx-auto flex w-full max-w-2xl flex-1 items-center justify-center p-6">
            <div
              role="alert"
              data-testid="host-file-error"
              className="grid w-full gap-3 rounded-2xl border border-brand-error/30 bg-brand-error/10 p-5 text-caption text-brand-error"
            >
              <p>
                {fileQuery.error instanceof Error
                  ? fileQuery.error.message
                  : String(fileQuery.error)}
              </p>
              <div>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={() => void fileQuery.refetch()}
                >
                  {t`Retry`}
                </Button>
              </div>
            </div>
          </div>
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
