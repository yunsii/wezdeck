// Shared context + inline triggers for opening host files (Agy artifacts,
// Claude/Grok plans, checkout source files) via `session.file` without
// creating circular imports between ChatMarkdown and FileViewerSheet.
import { useLingui } from '@lingui/react/macro'
import { ChevronRight, FileText } from 'lucide-react'
import { createContext, useContext, useEffect } from 'react'
import type { ReactNode } from 'react'

import { Button } from '#/components/ui/button'
import { SectionHeading } from '#/components/ui/section-heading'
import { formatLineRange } from '#/lib/host-file-link'
import type { HostFileTarget } from '#/lib/host-file-link'
import type { Message } from './chat-thread'

export type OpenHostFileArgs = HostFileTarget & { label?: string }

export type HostFileContextValue = {
  sessionId: string
  openFile: (target: OpenHostFileArgs) => void
  prefetchFile?: (target: OpenHostFileArgs) => void
}

export const HostFileContext = createContext<HostFileContextValue | null>(null)

export function useHostFileViewer() {
  return useContext(HostFileContext)
}

/**
 * Inline clickable host-file link rendered by ChatMarkdown when a `file://`
 * reference appears inside a session. Falls back to quiet text outside a
 * session context (e.g. landing page or standalone previews).
 */
export function HostFileLink({
  target,
  children,
}: {
  target: HostFileTarget
  children: ReactNode
}) {
  const viewer = useHostFileViewer()
  const range = formatLineRange(target.lineStart, target.lineEnd)
  if (!viewer?.sessionId) {
    return (
      <span className="font-mono text-caption text-brand-muted">
        {children}
      </span>
    )
  }
  const openArgs: OpenHostFileArgs = {
    ...target,
    label: typeof children === 'string' ? children : undefined,
  }
  const warm = () => viewer.prefetchFile?.(openArgs)
  return (
    <Button
      variant="plain"
      size="none"
      type="button"
      data-testid="host-file-link"
      data-host-file={target.path}
      title={range ? `${target.path} (${range})` : target.path}
      onPointerEnter={warm}
      onFocus={warm}
      onTouchStart={warm}
      onClick={() => viewer.openFile(openArgs)}
      className="inline-flex max-w-full items-center gap-1 rounded-lg bg-brand-soft/80 px-1.5 py-px align-baseline text-brand-running underline decoration-brand-running/40 underline-offset-2 transition-colors hover:bg-brand-soft"
    >
      <FileText size={13} aria-hidden className="shrink-0" />
      <span className="truncate">{children}</span>
      {range ? (
        <span className="shrink-0 font-mono text-meta text-brand-label no-underline">
          {range}
        </span>
      ) : null}
    </Button>
  )
}

/**
 * Prominent document card in ChatThread for Agy UserFacing artifacts
 * (`role: "system", kind: "artifact"` from native/wezdeck-wsl/agent_agy.go).
 */
export function ArtifactCard({
  message,
  onShown,
}: {
  message: Message
  onShown?: () => void
}) {
  const { t } = useLingui()
  const viewer = useHostFileViewer()
  useEffect(() => {
    onShown?.()
  }, [onShown])
  const path = message.file ?? ''
  const title = message.text || path.split('/').at(-1) || t`Document`
  const summary = message.body ?? ''
  const canOpen = Boolean(viewer?.sessionId && path)
  return (
    <div
      data-testid="artifact-card"
      data-artifact-path={path}
      className="grid gap-2 rounded-xl bg-brand-surface px-3.5 py-2.5"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-running/12 text-brand-running">
          <FileText size={16} aria-hidden />
        </span>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <span className="truncate text-body font-semibold text-brand-text">
            {title}
          </span>
          {summary ? (
            <p className="line-clamp-3 text-caption leading-snug text-brand-muted">
              {summary}
            </p>
          ) : null}
        </div>
      </div>
      {canOpen ? (
        <div className="flex items-center justify-end">
          <Button
            variant="solid"
            size="md"
            type="button"
            data-testid="artifact-open"
            onPointerEnter={() =>
              viewer?.prefetchFile?.({ path, label: title })
            }
            onFocus={() => viewer?.prefetchFile?.({ path, label: title })}
            onTouchStart={() => viewer?.prefetchFile?.({ path, label: title })}
            onClick={() => viewer?.openFile({ path, label: title })}
            className="min-h-9 gap-1 px-3 text-caption"
          >
            <span>{t`Read document`}</span>
            <ChevronRight size={14} aria-hidden />
          </Button>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Deduplicated list of artifacts / plans produced in this session, shown
 * inside SessionInfo so users can reopen any plan without scrolling up.
 */
export function SessionDocumentsSection({
  messages,
  onSelect,
}: {
  messages?: Array<Message>
  onSelect?: () => void
}) {
  const { t } = useLingui()
  const viewer = useHostFileViewer()
  if (!viewer?.sessionId || !messages?.length) return null
  const docs: Array<{ path: string; title: string; summary: string }> = []
  const seen = new Set<string>()
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'system' || m.kind !== 'artifact' || !m.file) continue
    if (seen.has(m.file)) continue
    seen.add(m.file)
    docs.push({
      path: m.file,
      title: m.text || m.file.split('/').at(-1) || t`Document`,
      summary: m.body ?? '',
    })
  }
  if (docs.length === 0) return null
  return (
    <section className="grid gap-1" data-testid="session-documents">
      <SectionHeading className="bg-brand-deck">{t`Documents`}</SectionHeading>
      <div className="divide-y divide-brand-edge overflow-hidden rounded-xl bg-brand-surface">
        {docs.map((doc) => (
          <Button
            key={doc.path}
            type="button"
            variant="plain"
            size="none"
            onPointerEnter={() =>
              viewer.prefetchFile?.({ path: doc.path, label: doc.title })
            }
            onFocus={() =>
              viewer.prefetchFile?.({ path: doc.path, label: doc.title })
            }
            onTouchStart={() =>
              viewer.prefetchFile?.({ path: doc.path, label: doc.title })
            }
            onClick={() => {
              onSelect?.()
              viewer.openFile({ path: doc.path, label: doc.title })
            }}
            className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-brand-soft"
          >
            <FileText size={16} aria-hidden className="text-brand-running" />
            <span className="grid min-w-0 gap-0.5">
              <span className="truncate text-body font-medium text-brand-text">
                {doc.title}
              </span>
              {doc.summary ? (
                <span className="truncate text-meta text-brand-muted">
                  {doc.summary}
                </span>
              ) : null}
            </span>
            <ChevronRight size={15} aria-hidden className="text-brand-label" />
          </Button>
        ))}
      </div>
    </section>
  )
}
