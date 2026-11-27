// Fullscreen ticket Net Diff drawer backed by `collab.diff`.
// Renders changed files grouped by repo/worktree using `chat-diff.tsx`'s
// Shiki-highlighted `ToolBody` with dual line numbers.
import { useLingui } from '@lingui/react/macro'
import { useQuery } from '@tanstack/react-query'
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  GitBranch,
  RefreshCw,
} from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '#/components/ui/button'
import { Sheet } from '#/components/ui/sheet'
import { Skeleton, SkeletonGroup } from '#/components/ui/skeleton'
import { trace } from '#/lib/client-trace'
import { hostRead } from '#/lib/runtime-client'
import { cn } from '#/lib/utils'
import { ToolBody } from './chat-diff'

type DiffFile = {
  path: string
  status: string
  additions: number
  deletions: number
  binary?: boolean
  truncated?: boolean
  patch?: string
}

type DiffRepo = {
  repo: string
  branch?: string
  base?: string
  worktree?: string
  source: string
  ticket_id: string
  additions: number
  deletions: number
  truncated?: boolean
  note?: string
  files: Array<DiffFile>
}

type CollabDiffResponse = {
  v: number
  ok: boolean
  id: string
  child?: string
  total_files: number
  total_additions: number
  total_deletions: number
  truncated?: boolean
  repos: Array<DiffRepo>
}

const STATUS_STYLE: Record<string, string> = {
  A: 'bg-brand-done/15 text-brand-done',
  '?': 'bg-brand-done/15 text-brand-done',
  D: 'bg-brand-error/15 text-brand-error',
  M: 'bg-brand-running/15 text-brand-running',
}

function DiffLoadingSkeleton() {
  const { t } = useLingui()
  return (
    <div
      data-testid="ticket-diff-loading"
      role="status"
      aria-live="polite"
      aria-label={t`Loading diff…`}
      className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 px-3 py-5 sm:px-6"
    >
      <div className="flex flex-1 flex-col rounded-2xl border border-brand-edge bg-brand-surface p-5">
        <SkeletonGroup className="flex flex-col gap-4">
          <div className="border-b border-brand-edge pb-3">
            <Skeleton className="h-5 w-48 rounded" />
          </div>
          <Skeleton className="h-44 w-full rounded-xl" />
          <Skeleton className="h-44 w-full rounded-xl" />
        </SkeletonGroup>
      </div>
    </div>
  )
}

function DiffFileCard({
  file,
  defaultOpen,
}: {
  file: DiffFile
  defaultOpen: boolean
}) {
  const { t } = useLingui()
  const [open, setOpen] = useState(defaultOpen)
  const badgeClass =
    STATUS_STYLE[file.status] ?? 'bg-brand-soft text-brand-muted'

  return (
    <div
      data-testid="ticket-diff-file"
      data-file={file.path}
      className="min-w-0 overflow-hidden rounded-xl border border-brand-edge bg-brand-surface"
    >
      <Button
        variant="plain"
        size="none"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className="flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left hover:bg-brand-soft/60"
      >
        {open ? (
          <ChevronDown size={15} className="shrink-0 text-brand-label" />
        ) : (
          <ChevronRight size={15} className="shrink-0 text-brand-label" />
        )}
        <span
          className={cn(
            'inline-flex size-5 shrink-0 items-center justify-center rounded font-mono text-meta font-semibold',
            badgeClass,
          )}
        >
          {file.status}
        </span>
        <FileCode2
          size={14}
          aria-hidden
          className="shrink-0 text-brand-muted"
        />
        <span className="min-w-0 flex-1 truncate font-mono text-caption text-brand-text">
          {file.path}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 font-mono text-meta tabular-nums">
          {file.additions > 0 ? (
            <span className="text-brand-done">+{file.additions}</span>
          ) : null}
          {file.deletions > 0 ? (
            <span className="text-brand-error">-{file.deletions}</span>
          ) : null}
        </span>
      </Button>
      {open ? (
        <div className="border-t border-brand-edge p-2">
          {file.binary ? (
            <p className="px-2 py-2 text-meta text-brand-muted">
              {t`Binary file changed`}
            </p>
          ) : file.patch ? (
            <ToolBody
              text={file.patch}
              file={file.path}
              scrollable={false}
              className="max-h-none"
            />
          ) : (
            <p className="px-2 py-2 text-meta text-brand-muted">
              {t`No text diff available`}
            </p>
          )}
        </div>
      ) : null}
    </div>
  )
}

export function TicketDiffSheet({
  ticketId,
  title,
  open,
  onClose,
}: {
  ticketId: string
  title: string
  open: boolean
  onClose: () => void
}) {
  const { t } = useLingui()
  const diffQuery = useQuery({
    queryKey: ['remote', 'collab.diff', ticketId],
    enabled: open && Boolean(ticketId),
    staleTime: 5_000,
    retry: false,
    queryFn: async () =>
      (await hostRead('collab.diff', { id: ticketId })) as CollabDiffResponse,
  })

  useEffect(() => {
    if (!open || !diffQuery.data) return
    trace('ticket-diff-open', {
      id: ticketId,
      files: diffQuery.data.total_files,
      additions: diffQuery.data.total_additions,
      deletions: diffQuery.data.total_deletions,
    })
  }, [open, ticketId, diffQuery.data])

  const data = diffQuery.data
  const fileCount = data?.total_files ?? 0
  const subtitle = (
    <div className="flex min-w-0 items-center gap-2 font-mono text-meta text-brand-muted tabular-nums">
      <span className="truncate">{title}</span>
      {data ? (
        <>
          <span>·</span>
          <span>{t`${fileCount} files`}</span>
          <span className="text-brand-done">+{data.total_additions}</span>
          <span className="text-brand-error">-{data.total_deletions}</span>
        </>
      ) : null}
    </div>
  )

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      fullscreen
      title={t`Net diff`}
      subtitle={subtitle}
      testId="ticket-diff-sheet"
      actions={
        <Button
          variant="ghost"
          size="none"
          type="button"
          aria-label={t`Refresh`}
          title={t`Refresh`}
          disabled={diffQuery.isFetching}
          onClick={() => void diffQuery.refetch()}
          className="inline-flex size-8 items-center justify-center rounded-lg text-brand-muted"
        >
          <RefreshCw
            size={14}
            aria-hidden
            className={cn(diffQuery.isFetching && 'animate-spin')}
          />
        </Button>
      }
    >
      <div className="flex min-h-full w-full min-w-0 flex-col">
        {diffQuery.isPending ? (
          <DiffLoadingSkeleton />
        ) : diffQuery.isError ? (
          <div className="mx-auto flex w-full max-w-2xl flex-1 items-center justify-center p-6">
            <p
              role="alert"
              className="w-full rounded-2xl border border-brand-error/30 bg-brand-error/10 p-5 text-caption text-brand-error"
            >
              {diffQuery.error instanceof Error
                ? diffQuery.error.message
                : String(diffQuery.error)}
            </p>
          </div>
        ) : !data || data.repos.length === 0 ? (
          <div className="mx-auto flex w-full max-w-2xl flex-1 items-center justify-center p-6">
            <p className="text-center text-caption text-brand-muted">
              {t`No active worktree diff is available for this ticket.`}
            </p>
          </div>
        ) : (
          <div className="mx-auto grid w-full max-w-5xl min-w-0 grid-cols-[minmax(0,1fr)] gap-5 px-3 py-4 sm:px-6 md:py-6">
            {data.truncated ? (
              <p
                role="status"
                className="rounded-xl bg-brand-waiting/10 px-3.5 py-2 text-meta text-brand-text"
              >
                {t`Large diff was capped for mobile viewing.`}
              </p>
            ) : null}
            {data.repos.map((repo) => (
              <section
                key={`${repo.repo}-${repo.ticket_id}`}
                className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2.5"
              >
                <div className="flex flex-wrap items-center gap-2 px-1">
                  <span className="text-body font-semibold text-brand-text">
                    {repo.repo}
                  </span>
                  {repo.branch ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-brand-edge bg-brand-surface px-2 py-0.5 font-mono text-meta text-brand-muted">
                      <GitBranch size={12} aria-hidden />
                      {repo.branch}
                    </span>
                  ) : null}
                  {repo.base ? (
                    <span className="font-mono text-meta text-brand-label">
                      base {repo.base}
                    </span>
                  ) : null}
                  <span className="ml-auto flex items-center gap-1.5 font-mono text-meta tabular-nums">
                    <span className="text-brand-done">+{repo.additions}</span>
                    <span className="text-brand-error">-{repo.deletions}</span>
                  </span>
                </div>
                {repo.note ? (
                  <p className="rounded-xl border border-brand-edge bg-brand-surface px-3.5 py-2.5 text-caption text-brand-muted">
                    {repo.note}
                  </p>
                ) : repo.files.length === 0 ? (
                  <p className="rounded-xl border border-brand-edge bg-brand-surface px-3.5 py-2.5 text-caption text-brand-muted">
                    {t`Working tree matches base commit (no diff).`}
                  </p>
                ) : (
                  <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
                    {repo.files.map((file, idx) => (
                      <DiffFileCard
                        key={file.path}
                        file={file}
                        defaultOpen={idx < 10}
                      />
                    ))}
                  </div>
                )}
              </section>
            ))}
          </div>
        )}
      </div>
    </Sheet>
  )
}
