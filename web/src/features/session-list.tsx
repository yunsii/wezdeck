// Sessions list as a repo → worktree → pane tree. Grouping is by git path so
// ticket agents on the same worktree can join later; tmux primary/secondary
// is optional mount info only.
import { useLingui } from '@lingui/react/macro'
import { Link } from '@tanstack/react-router'

import { Led } from '#/components/deck/led'
import { useLocale } from '#/lib/locale-context'
import { useAgo } from './tickets-view'
import {
  humanPrompt,
  sessionTone,
  useSessions,
  useStatusText,
} from './console-sessions'
import type { SessionCard } from './console-sessions'

type WorktreeGroup = {
  key: string
  label: string
  ts: number
  rows: Array<SessionCard>
}

type RepoGroup = {
  key: string
  label: string
  ts: number
  worktrees: Array<WorktreeGroup>
}

const ts = (iso?: number) => (iso ? new Date(iso).toISOString() : undefined)

/** Group by repo family → worktree path; tmux pane_role only sorts within a worktree. */
export function buildSessionTree(rows: Array<SessionCard>): Array<RepoGroup> {
  const repos = new Map<
    string,
    { label: string; ts: number; trees: Map<string, WorktreeGroup> }
  >()
  for (const row of rows) {
    const repoKey = row.repo_root || row.repo || row.cwd || row.id
    const repoLabel =
      row.repo ||
      row.repo_root?.split('/').filter(Boolean).at(-1) ||
      row.cwd.split('/').filter(Boolean).at(-1) ||
      row.id.slice(0, 8)
    const wtKey = row.worktree || row.cwd || row.id
    const wtLabel =
      (row.worktree || row.cwd).split('/').filter(Boolean).at(-1) || wtKey
    let repo = repos.get(repoKey)
    if (!repo) {
      repo = { label: repoLabel, ts: 0, trees: new Map() }
      repos.set(repoKey, repo)
    }
    let tree = repo.trees.get(wtKey)
    if (!tree) {
      tree = { key: wtKey, label: wtLabel, ts: 0, rows: [] }
      repo.trees.set(wtKey, tree)
    }
    tree.rows.push(row)
    tree.ts = Math.max(tree.ts, row.ts || 0)
    repo.ts = Math.max(repo.ts, row.ts || 0)
  }
  const roleRank = (role?: string) =>
    role === 'primary' ? 0 : role === 'secondary' ? 1 : 2
  return [...repos.entries()]
    .map(([key, repo]) => ({
      key,
      label: repo.label,
      ts: repo.ts,
      worktrees: [...repo.trees.values()]
        .map((tree) => ({
          ...tree,
          rows: [...tree.rows].sort((a, b) => {
            const byRole = roleRank(a.pane_role) - roleRank(b.pane_role)
            if (byRole) return byRole
            return (b.ts || 0) - (a.ts || 0)
          }),
        }))
        .sort((a, b) => b.ts - a.ts),
    }))
    .sort((a, b) => b.ts - a.ts)
}

export function SessionList() {
  const { t } = useLingui()
  const { locale } = useLocale()
  const localeParam = locale === 'en' ? undefined : locale
  const sessions = useSessions()
  const ago = useAgo()
  const statusText = useStatusText()
  const rows = sessions.data?.sessions ?? []
  const tree = buildSessionTree(rows)
  const paneLabel = (role?: string) =>
    role === 'primary' ? t`Primary` : role === 'secondary' ? t`Secondary` : ''

  const titleOf = (row: SessionCard) =>
    row.title ||
    row.window ||
    row.worktree?.split('/').filter(Boolean).at(-1) ||
    row.cwd.split('/').filter(Boolean).at(-1) ||
    row.id.slice(0, 8)

  const tag = (text: string) => (
    <span className="shrink-0 rounded-full bg-brand-deck px-1.5 py-0.5 text-[11px] text-brand-label">
      {text}
    </span>
  )

  const sessionLink = (row: SessionCard) => {
    const prompt = humanPrompt(row.last_prompt)
    const status = statusText(
      row.status,
      row.waiting_kind,
      row.running_kind,
      row.background?.length ?? 0,
    )
    return (
      <Link
        to="/{-$locale}/console/sessions/$id"
        params={{ locale: localeParam, id: row.id }}
        data-session={row.id}
        data-pane-role={row.pane_role || undefined}
        className="key-press flex min-h-14 items-start gap-3 px-4 py-3"
      >
        <span className="pt-1.5">
          <Led tone={sessionTone(row.status, row.waiting_kind)} size={12} />
        </span>
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="flex items-baseline justify-between gap-2">
            <span className="truncate text-[16px] font-semibold">
              {titleOf(row)}
            </span>
            <span className="shrink-0 text-xs text-brand-label">
              {ago(ts(row.ts))}
            </span>
          </span>
          <span className="truncate text-sm text-brand-muted">
            {prompt || t`No human message yet`}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-1">
            {row.pane_role ? tag(paneLabel(row.pane_role)) : null}
            {row.agent && row.agent !== 'agent' ? tag(row.agent) : null}
            {row.name && row.name !== row.agent ? tag(row.name) : null}
            {status ? tag(status) : null}
            {row.branch ? tag(row.branch) : null}
          </span>
        </span>
      </Link>
    )
  }

  return (
    <div className="grid max-w-2xl content-start gap-3">
      <h1 className="hidden text-base font-semibold md:block">
        {t({ message: 'Sessions', context: 'nav' })}
      </h1>
      <p className="text-sm text-brand-muted">
        {t`Grouped by repo and worktree. Primary / secondary mark tmux panes when present.`}
      </p>
      {sessions.isError ? (
        <p
          role="status"
          className="rounded-[12px] bg-brand-waiting/10 px-3 py-2 text-sm"
        >
          {String(sessions.error.message)}
        </p>
      ) : null}
      {rows.length === 0 && !sessions.isError ? (
        <p className="rounded-[14px] bg-brand-surface px-4 py-10 text-center text-sm text-brand-muted">
          {sessions.isPending ? t`Loading…` : t`No agent sessions are running.`}
        </p>
      ) : (
        <div aria-label={t`Agent sessions`} className="grid gap-3">
          {tree.map((repo) => (
            <section
              key={repo.key}
              className="overflow-hidden rounded-[16px] bg-brand-surface"
              data-repo={repo.label}
            >
              <h2 className="border-b border-brand-edge px-4 py-2.5 text-[15px] font-semibold">
                {repo.label}
              </h2>
              {repo.worktrees.map((wt) => {
                const showWt =
                  repo.worktrees.length > 1 || wt.label !== repo.label
                return (
                  <div key={wt.key} data-worktree={wt.label}>
                    {showWt ? (
                      <p className="border-b border-brand-edge px-4 py-1.5 text-[12px] text-brand-label">
                        {wt.label}
                      </p>
                    ) : null}
                    <ul>
                      {wt.rows.map((row) => (
                        <li
                          key={row.id}
                          className="border-b border-brand-edge last:border-b-0"
                        >
                          {sessionLink(row)}
                        </li>
                      ))}
                    </ul>
                  </div>
                )
              })}
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
