// Body renderers for `FileViewerSheet`: full-height loading skeleton,
// Shiki-highlighted code view with `#L10-L20` scrolling, and responsive
// document Markdown view with mobile collapsible TOC & sticky desktop TOC rail.
import { useLingui } from '@lingui/react/macro'
import { List } from 'lucide-react'
import { startTransition, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '#/components/ui/button'
import { Disclosure } from '#/components/ui/disclosure'
import { Skeleton, SkeletonGroup } from '#/components/ui/skeleton'
import { highlightLines, langOf } from '#/lib/highlight'
import type { Token } from '#/lib/highlight'
import { extractMarkdownHeadings } from '#/lib/host-file-link'
import type { MarkdownHeading } from '#/lib/host-file-link'
import { cn } from '#/lib/utils'
import { ChatMarkdown } from './chat-markdown'

function useCodeTokens(content: string, lang: string | null) {
  const [tokens, setTokens] = useState<Array<Array<Token>> | null>(null)
  useEffect(() => {
    if (!lang || !content) {
      setTokens(null)
      return
    }
    let live = true
    void highlightLines(content.split('\n'), lang).then((res) => {
      if (live) startTransition(() => setTokens(res))
    })
    return () => {
      live = false
    }
  }, [content, lang])
  return tokens
}

export function FileLoadingSkeleton({ isCode = false }: { isCode?: boolean }) {
  const { t } = useLingui()
  return (
    <div
      data-testid="host-file-loading"
      role="status"
      aria-live="polite"
      aria-label={t`Loading…`}
      className={cn(
        'mx-auto w-full min-w-0 px-3 py-4 sm:px-6 md:py-6',
        isCode ? 'max-w-6xl' : 'max-w-4xl',
      )}
    >
      <div className="rounded-2xl border border-brand-edge/70 bg-brand-surface px-4 py-5 sm:px-7 sm:py-7 md:px-9 md:py-8">
        <SkeletonGroup className="flex flex-col gap-5">
          <div className="border-b border-brand-edge pb-4">
            <Skeleton className="h-7 w-2/3 rounded-lg" />
          </div>
          <div className="grid gap-2.5">
            <Skeleton className="h-4 w-full rounded" />
            <Skeleton className="h-4 w-11/12 rounded" />
            <Skeleton className="h-4 w-4/5 rounded" />
          </div>
          <Skeleton className="h-44 w-full rounded-xl" />
          <div className="grid gap-2.5">
            <Skeleton className="h-5 w-1/3 rounded-lg" />
            <Skeleton className="h-4 w-full rounded" />
            <Skeleton className="h-4 w-10/12 rounded" />
            <Skeleton className="h-4 w-3/4 rounded" />
          </div>
          <div className="grid gap-2.5 pt-2">
            <Skeleton className="h-4 w-full rounded" />
            <Skeleton className="h-4 w-5/6 rounded" />
          </div>
        </SkeletonGroup>
      </div>
    </div>
  )
}

const CODE_CHUNK_LINES = 60

export function CodeFileBody({
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
  const chunks = useMemo(() => {
    const out: Array<{ start: number; items: Array<string> }> = []
    for (let i = 0; i < lines.length; i += CODE_CHUNK_LINES) {
      out.push({ start: i, items: lines.slice(i, i + CODE_CHUNK_LINES) })
    }
    return out
  }, [lines])
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
    <div className="mx-auto w-full max-w-6xl min-w-0 px-3 py-4 sm:px-6 md:py-6">
      <pre
        data-testid="host-file-code"
        data-lang={lang ?? undefined}
        className="min-w-0 max-w-full overflow-x-auto rounded-2xl border border-brand-edge bg-brand-surface py-3 font-mono text-meta leading-relaxed"
      >
        <div>
          {chunks.map((chunk) => {
            const firstNo = chunk.start + 1
            const lastNo = chunk.start + chunk.items.length
            const keepImmediate =
              chunk.start === 0 ||
              Boolean(lineStart && lineStart >= firstNo && lineStart <= lastNo)
            return (
              <div
                key={chunk.start}
                className={keepImmediate ? undefined : 'code-chunk'}
              >
                {chunk.items.map((raw, offset) => {
                  const i = chunk.start + offset
                  const no = i + 1
                  const hit = Boolean(
                    lineStart && no >= lineStart && no <= rangeEnd,
                  )
                  const lineTokens = tokens?.[i]
                  return (
                    <div
                      key={no}
                      ref={no === lineStart ? targetRef : undefined}
                      data-line={no}
                      data-highlighted={hit ? 'true' : undefined}
                      className={cn(
                        'flex min-w-0 px-3',
                        hit && 'bg-brand-running/15',
                      )}
                    >
                      <span
                        aria-hidden
                        style={{ width: `${numWidth + 1}ch` }}
                        className={cn(
                          'shrink-0 pr-3 text-right tabular-nums select-none',
                          hit
                            ? 'font-medium text-brand-running'
                            : 'text-brand-label/70',
                        )}
                      >
                        {no}
                      </span>
                      <span className="min-w-0 flex-1 whitespace-pre">
                        {lineTokens
                          ? lineTokens.map((tok, ti) => (
                              <span
                                key={ti}
                                className="code-token"
                                style={tok.style}
                              >
                                {tok.content}
                              </span>
                            ))
                          : raw || ' '}
                      </span>
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </pre>
    </div>
  )
}

function TocList({
  headings,
  onJump,
}: {
  headings: Array<MarkdownHeading>
  onJump: (text: string) => void
}) {
  return (
    <ul className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-0.5">
      {headings.map((h) => (
        <li key={`${h.index}-${h.text}`} className="min-w-0">
          <Button
            variant="plain"
            size="none"
            type="button"
            onClick={() => onJump(h.text)}
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
  )
}

export function MarkdownFileBody({ content }: { content: string }) {
  const { t } = useLingui()
  const containerRef = useRef<HTMLDivElement>(null)
  const headings = useMemo(() => extractMarkdownHeadings(content), [content])
  const hasToc = headings.length >= 2

  const jumpTo = (text: string) => {
    const root = containerRef.current
    if (!root) return
    const nodes = root.querySelectorAll('[data-doc-heading]')
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
      className={cn(
        'mx-auto w-full min-w-0 px-3 py-4 sm:px-6 md:py-6',
        hasToc ? 'max-w-6xl' : 'max-w-4xl',
      )}
    >
      {hasToc ? (
        <div className="mb-3 lg:hidden">
          <Disclosure
            defaultOpen={false}
            triggerClassName="rounded-xl border border-brand-edge bg-brand-surface px-3.5 py-2.5 text-caption font-medium text-brand-text"
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
            <div className="rounded-xl border border-brand-edge bg-brand-surface p-2">
              <TocList headings={headings} onJump={jumpTo} />
            </div>
          </Disclosure>
        </div>
      ) : null}

      <div
        className={cn(
          'grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6',
          hasToc && 'lg:grid-cols-[minmax(0,1fr)_15rem] lg:items-start',
        )}
      >
        <article className="min-w-0 max-w-full rounded-2xl border border-brand-edge/70 bg-brand-surface px-4 py-5 text-brand-text sm:px-7 sm:py-7 md:px-9 md:py-8">
          <ChatMarkdown text={content} variant="document" />
        </article>

        {hasToc ? (
          <aside className="sticky top-6 hidden min-w-0 rounded-2xl border border-brand-edge/70 bg-brand-surface p-3 lg:block">
            <div className="mb-2 flex items-center gap-1.5 px-2 text-meta font-semibold text-brand-label">
              <List size={13} aria-hidden />
              <span>{t`Contents`}</span>
              <span className="ml-auto font-mono font-normal tabular-nums">
                {headings.length}
              </span>
            </div>
            <div className="max-h-[calc(100dvh-10rem)] overflow-y-auto">
              <TocList headings={headings} onJump={jumpTo} />
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  )
}
