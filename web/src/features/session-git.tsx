// The header's git tag, opened: what +S ~U ?T ↑A ↓B mean for this checkout
// in one sentence, then the changed files by state, the commits not pushed /
// not pulled yet and the recent ones. The counts ride the session poll
// (git_status.go); the lists are read on open only (`session.git`,
// native/wezdeck-wsl/session_git.go).
import { useLingui } from '@lingui/react/macro'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { GitStatusTag, NoExpand } from '#/components/deck/session-tags'
import type { GitStatus } from '#/components/deck/session-tags'
import { Segmented } from '#/components/deck/segmented'
import { Button } from '#/components/ui/button'
import { Sheet } from '#/components/ui/sheet'
import { hostRead } from '#/lib/runtime-client'
import { trace } from '#/lib/client-trace'
import { cn } from '#/lib/utils'
import { useAgo } from './tickets-view'
import { defaultGitTab } from './git-tab'
import type { GitTab } from './git-tab'

export type GitFile = {
  path: string
  state: 'staged' | 'modified' | 'untracked' | 'conflict'
  code: string
}
export type GitCommit = {
  sha: string
  subject: string
  /** the message after the subject (clipped by the host) */
  body?: string
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

/**
 * One commit on two lines — the subject with the whole row to wrap in (up
 * to three lines), then sha · author · time — so a phone reads it whole; one
 * with a body opens in place to it.
 */
function CommitRow({ commit, when }: { commit: GitCommit; when: string }) {
  const [open, setOpen] = useState(false)
  const lines = (
    <>
      <span
        className={cn(
          'text-caption leading-snug text-brand-text',
          !open && 'line-clamp-3',
        )}
      >
        {commit.subject}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-meta text-brand-label">
        <span className="font-mono">{commit.sha}</span>
        <span aria-hidden>·</span>
        <span className="truncate">{commit.author}</span>
        <span aria-hidden>·</span>
        <span className="shrink-0">{when}</span>
        {commit.body ? (
          <span
            aria-hidden
            className={cn('ml-auto shrink-0 transition', open && 'rotate-90')}
          >
            ›
          </span>
        ) : null}
      </span>
    </>
  )
  return (
    <li data-commit={commit.sha}>
      {commit.body ? (
        <Button
          variant="plain"
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="grid w-full min-w-0 gap-0.5 rounded-lg px-1 py-1.5 text-left"
        >
          {lines}
        </Button>
      ) : (
        <div className="grid min-w-0 gap-0.5 px-1 py-1.5">{lines}</div>
      )}
      {open && commit.body ? (
        <p className="mx-1 mb-1.5 rounded-lg bg-brand-surface px-2.5 py-2 text-meta leading-relaxed whitespace-pre-wrap text-brand-muted">
          {commit.body}
        </p>
      ) : null}
    </li>
  )
}

function Commits({
  title,
  commits,
  tone,
}: {
  title: string
  commits: Array<GitCommit>
  /** needs you: not pushed (accent) / not pulled (waiting) */
  tone?: 'ahead' | 'behind'
}) {
  const ago = useAgo()
  if (!commits.length) return null
  return (
    <section data-git-commits={tone ?? 'recent'} className="grid gap-1">
      <h3
        className={cn(
          'px-1 text-meta',
          tone === 'ahead'
            ? 'font-semibold text-brand-running'
            : tone === 'behind'
              ? 'font-semibold text-brand-waiting'
              : 'text-brand-label',
        )}
      >
        {title} · {commits.length}
      </h3>
      <ul className="grid gap-0.5">
        {commits.map((commit) => (
          <CommitRow
            key={commit.sha}
            commit={commit}
            when={ago(new Date(commit.at).toISOString())}
          />
        ))}
      </ul>
    </section>
  )
}

/** distinct paths (a file staged and modified is listed twice) */
const changedPaths = (detail: GitDetail) =>
  new Set(detail.files.map((file) => file.path)).size

/**
 * The lists (also what 交互调试 › git 状态 shows from sample data): the
 * sentence over two tabs — 变更 (files by state) and 提交 (not pushed, not
 * pulled, then recent) — opening on whichever explains the tag; ← → switch.
 */
export function GitDetailView({ detail }: { detail: GitDetail }) {
  const { t } = useLingui()
  const sentence = useGitSentence()
  const [tab, setTab] = useState<GitTab>(() => defaultGitTab(detail))
  const groups: Array<{ state: GitFile['state']; title: string }> = [
    { state: 'conflict', title: t({ message: 'Conflicts', context: 'git' }) },
    { state: 'staged', title: t({ message: 'Staged', context: 'git' }) },
    { state: 'modified', title: t({ message: 'Modified', context: 'git' }) },
    { state: 'untracked', title: t({ message: 'Untracked', context: 'git' }) },
  ]
  const { ahead, behind } = detail.status
  const sync = [ahead ? `↑${ahead}` : '', behind ? `↓${behind}` : '']
    .filter(Boolean)
    .join(' ')
  return (
    <div
      data-testid="git-detail"
      data-tab={tab}
      className="grid gap-3"
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        const next = tab === 'changes' ? 'commits' : 'changes'
        setTab(next)
        // keep focus on the switch, now on the other segment
        requestAnimationFrame(() =>
          event.currentTarget
            .querySelector<HTMLElement>(`[role=radio][data-value=${next}]`)
            ?.focus(),
        )
      }}
    >
      <p className="px-1 text-caption leading-relaxed text-brand-muted">
        {detail.branch ? (
          <span className="mr-1 font-mono text-brand-text">
            {detail.branch}
            {detail.upstream ? ` → ${detail.upstream}` : ''}
          </span>
        ) : null}
        {sentence(detail.status)}
      </p>
      <Segmented
        label={t`Git status`}
        value={tab}
        onChange={setTab}
        options={[
          {
            value: 'changes',
            label: t({ message: 'Changes', context: 'git' }),
            count: changedPaths(detail),
          },
          {
            value: 'commits',
            label: (
              <>
                {t({ message: 'Commits', context: 'git' })}
                {sync ? (
                  <span className="ml-1 text-[0.85em] tabular-nums opacity-70">
                    {sync}
                  </span>
                ) : null}
              </>
            ),
          },
        ]}
      />
      {/* one height for both tabs (the sheet held still while switching);
          a long list scrolls inside */}
      <div
        data-testid="git-tab-body"
        className="h-[min(50dvh,24rem)] overflow-y-auto overscroll-contain"
      >
        {tab === 'changes' ? (
          <div className="grid content-start gap-3">
            {groups.map(({ state, title }) => {
              const files = detail.files.filter((file) => file.state === state)
              if (!files.length) return null
              return (
                <section
                  key={state}
                  data-git-group={state}
                  className="grid gap-1"
                >
                  <h3 className="px-1 text-meta text-brand-label">
                    {title} · {files.length}
                  </h3>
                  <ul className="grid gap-0.5">
                    {files.map((file) => (
                      <li
                        key={`${state}:${file.path}`}
                        className="flex min-w-0 items-baseline gap-2 px-1 font-mono text-meta"
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
            {detail.files.length ? null : (
              <p className="px-1 py-4 text-center text-caption text-brand-muted">
                {t`No uncommitted changes.`}
              </p>
            )}
            {detail.truncated ? (
              <p className="px-1 text-meta text-brand-label">
                {t`More files changed than listed here.`}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="grid content-start gap-3">
            {/* what needs you first, in colour; the recent ones for reference */}
            <Commits
              title={t`Not pushed`}
              commits={detail.ahead}
              tone="ahead"
            />
            <Commits
              title={t`Not pulled`}
              commits={detail.behind}
              tone="behind"
            />
            <Commits title={t`Recent commits`} commits={detail.recent} />
          </div>
        )}
      </div>
    </div>
  )
}

/** the tag in the header: a button that opens the sheet */
export function GitStatusButton({
  id,
  git,
  sample,
}: {
  id: string
  git: GitStatus
  /** 交互调试: show this instead of reading the host */
  sample?: GitDetail
}) {
  const { t } = useLingui()
  const [open, setOpen] = useState(false)
  const read = useQuery({
    queryKey: ['remote', 'session-git', id],
    enabled: open && !sample,
    staleTime: 5_000,
    queryFn: async () => (await hostRead('session.git', { id })) as GitDetail,
  })
  const detail = sample
    ? { data: sample, isError: false as const, error: null }
    : read
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
        <NoExpand>
          <GitStatusTag git={git} />
        </NoExpand>
      </Button>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title={t`Git status`}
        testId="git-sheet"
      >
        {/* px-3 + the rows' own px-1: in line with the title's px-4 */}
        <div className="px-3">
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
        </div>
      </Sheet>
    </>
  )
}
