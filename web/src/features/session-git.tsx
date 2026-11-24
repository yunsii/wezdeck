// The header's git tag, opened: what +S ~U ?T ↑A ↓B mean for this checkout
// in one sentence, then the changed files by state, the commits not pushed /
// not pulled yet and the recent ones. The counts ride the session poll
// (git_status.go); the lists are read on open only (`session.git`,
// native/wezdeck-wsl/session_git.go).
import { useLingui } from '@lingui/react/macro'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { GitStatusTag } from '#/components/deck/session-tags'
import type { GitStatus } from '#/components/deck/session-tags'
import { Button } from '#/components/ui/button'
import { Sheet } from '#/components/ui/sheet'
import { hostRead } from '#/lib/runtime-client'
import { trace } from '#/lib/client-trace'
import { useAgo } from './tickets-view'

export type GitFile = {
  path: string
  state: 'staged' | 'modified' | 'untracked' | 'conflict'
  code: string
}
export type GitCommit = {
  sha: string
  subject: string
  author: string
  at: number
}
export type GitDetail = {
  status: GitStatus
  branch?: string
  upstream?: string
  files: Array<GitFile>
  truncated?: boolean
  ahead: Array<GitCommit>
  behind: Array<GitCommit>
  recent: Array<GitCommit>
}

/** the counts in words: what the tag's shorthand says */
export function useGitSentence() {
  const { t } = useLingui()
  return (git: GitStatus) => {
    const { staged, unstaged, untracked, ahead, behind } = git
    const parts = [
      staged ? t`${staged} staged` : '',
      unstaged ? t`${unstaged} modified` : '',
      untracked ? t`${untracked} untracked` : '',
    ].filter(Boolean)
    const list = parts.join(t({ message: ', ', context: 'list separator' }))
    const files = parts.length ? t`Files: ${list}.` : t`No uncommitted changes.`
    const sync = !git.upstream
      ? t`No upstream branch: nothing to compare with.`
      : ahead && behind
        ? t`${ahead} commits to push, ${behind} to pull.`
        : ahead
          ? t`${ahead} commits not pushed yet.`
          : behind
            ? t`${behind} commits to pull.`
            : t`Level with upstream.`
    return `${files} ${sync}`
  }
}

function Commits({
  title,
  commits,
}: {
  title: string
  commits: Array<GitCommit>
}) {
  const ago = useAgo()
  if (!commits.length) return null
  return (
    <section className="grid gap-1">
      <h3 className="px-1 text-meta text-brand-label">
        {title} · {commits.length}
      </h3>
      <ul className="grid gap-0.5">
        {commits.map((commit) => (
          <li
            key={commit.sha}
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-2 rounded-lg px-2 py-1"
          >
            <span className="font-mono text-meta text-brand-label">
              {commit.sha}
            </span>
            <span className="truncate text-caption text-brand-text">
              {commit.subject}
            </span>
            <span className="text-meta text-brand-label">
              {ago(new Date(commit.at).toISOString())}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** the lists (also what 交互调试 › git 状态 shows from sample data) */
export function GitDetailView({ detail }: { detail: GitDetail }) {
  const { t } = useLingui()
  const sentence = useGitSentence()
  const groups: Array<{ state: GitFile['state']; title: string }> = [
    { state: 'conflict', title: t`Conflicts` },
    { state: 'staged', title: t`Staged` },
    { state: 'modified', title: t`Modified` },
    { state: 'untracked', title: t`Untracked` },
  ]
  return (
    <div data-testid="git-detail" className="grid gap-3">
      <p className="px-1 text-caption leading-relaxed text-brand-muted">
        {detail.branch ? (
          <span className="mr-1 font-mono text-brand-text">
            {detail.branch}
            {detail.upstream ? ` → ${detail.upstream}` : ''}
          </span>
        ) : null}
        {sentence(detail.status)}
      </p>
      {groups.map(({ state, title }) => {
        const files = detail.files.filter((file) => file.state === state)
        if (!files.length) return null
        return (
          <section key={state} data-git-group={state} className="grid gap-1">
            <h3 className="px-1 text-meta text-brand-label">
              {title} · {files.length}
            </h3>
            <ul className="grid gap-0.5">
              {files.map((file) => (
                <li
                  key={`${state}:${file.path}`}
                  className="flex min-w-0 items-baseline gap-2 px-2 font-mono text-meta"
                >
                  <span className="w-3 shrink-0 text-brand-label">
                    {file.code}
                  </span>
                  <span className="min-w-0 truncate text-brand-text">
                    {file.path}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
      {detail.truncated ? (
        <p className="px-1 text-meta text-brand-label">
          {t`More files changed than listed here.`}
        </p>
      ) : null}
      <Commits title={t`Not pushed`} commits={detail.ahead} />
      <Commits title={t`Not pulled`} commits={detail.behind} />
      <Commits title={t`Recent commits`} commits={detail.recent} />
    </div>
  )
}

/** the tag in the header: a button that opens the sheet */
export function GitStatusButton({ id, git }: { id: string; git: GitStatus }) {
  const { t } = useLingui()
  const [open, setOpen] = useState(false)
  const detail = useQuery({
    queryKey: ['remote', 'session-git', id],
    enabled: open,
    staleTime: 5_000,
    queryFn: async () => (await hostRead('session.git', { id })) as GitDetail,
  })
  return (
    <>
      <Button
        variant="plain"
        type="button"
        data-testid="git-status-button"
        aria-haspopup="dialog"
        onClick={() => {
          trace('git-panel', { open: true })
          setOpen(true)
        }}
        className="inline-flex shrink-0 rounded-full"
      >
        <GitStatusTag git={git} />
      </Button>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title={t`Git status`}
        testId="git-sheet"
      >
        {detail.data ? (
          <GitDetailView detail={detail.data} />
        ) : detail.isError ? (
          <p className="py-6 text-center text-caption text-brand-muted">
            {String(detail.error.message)}
          </p>
        ) : (
          <p className="py-6 text-center text-caption text-brand-muted">
            {t`Loading…`}
          </p>
        )}
      </Sheet>
    </>
  )
}
