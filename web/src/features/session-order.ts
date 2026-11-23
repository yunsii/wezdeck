// Session list order (pure, unit-tested): repo → worktree groups sorted by
// the later of the desk visit (access ledger, like Alt+g) and a visit from
// this phone — never by agent output, so the list holds still while agents
// work.
import type { SessionCard } from './console-sessions'

type WorktreeGroup = {
  key: string
  label: string
  visit: number
  rows: Array<SessionCard>
}

type RepoGroup = {
  key: string
  label: string
  visit: number
  worktrees: Array<WorktreeGroup>
}

export const worktreeKey = (row: SessionCard) =>
  row.worktree || row.cwd || row.id

/** later of the desk visit and this phone's */
export function visitOf(row: SessionCard, phone: Record<string, number>) {
  return Math.max(row.visited ?? 0, phone[worktreeKey(row)] ?? 0)
}

/** the repo as the desk names it: its alias when one is set */
export const repoName = (row: { repo?: string; repo_label?: string }) =>
  row.repo_label || row.repo || ''

/**
 * Group by repo family → worktree path. Groups sort by the latest visit;
 * never-visited ones (ticket agents) sink and order by name, so nothing
 * moves unless you go somewhere. Within a worktree: primary, secondary.
 */
export function buildSessionTree(
  rows: Array<SessionCard>,
  phone: Record<string, number> = {},
): Array<RepoGroup> {
  const repos = new Map<
    string,
    { label: string; visit: number; trees: Map<string, WorktreeGroup> }
  >()
  for (const row of rows) {
    const repoKey = row.repo_root || row.repo || row.cwd || row.id
    const repoLabel =
      repoName(row) ||
      row.repo_root?.split('/').filter(Boolean).at(-1) ||
      row.cwd.split('/').filter(Boolean).at(-1) ||
      row.id.slice(0, 8)
    const wtKey = worktreeKey(row)
    const base = (row.worktree || row.cwd).split('/').filter(Boolean).at(-1)
    // the main checkout is named after the repo: show it by its alias too
    const wtLabel = (base && base === row.repo ? repoName(row) : base) || wtKey
    const visit = visitOf(row, phone)
    let repo = repos.get(repoKey)
    if (!repo) {
      repo = { label: repoLabel, visit: 0, trees: new Map() }
      repos.set(repoKey, repo)
    }
    let tree = repo.trees.get(wtKey)
    if (!tree) {
      tree = { key: wtKey, label: wtLabel, visit: 0, rows: [] }
      repo.trees.set(wtKey, tree)
    }
    tree.rows.push(row)
    tree.visit = Math.max(tree.visit, visit)
    repo.visit = Math.max(repo.visit, visit)
  }
  const byVisit = (
    a: { visit: number; label: string },
    b: { visit: number; label: string },
  ) => b.visit - a.visit || a.label.localeCompare(b.label)
  const roleRank = (role?: string) =>
    role === 'primary' ? 0 : role === 'secondary' ? 1 : 2
  return [...repos.entries()]
    .map(([key, repo]) => ({
      key,
      label: repo.label,
      visit: repo.visit,
      worktrees: [...repo.trees.values()]
        .map((tree) => ({
          ...tree,
          rows: [...tree.rows].sort(
            (a, b) =>
              roleRank(a.pane_role) - roleRank(b.pane_role) ||
              (a.pane_index ?? 0) - (b.pane_index ?? 0) ||
              a.id.localeCompare(b.id),
          ),
        }))
        .sort(byVisit),
    }))
    .sort(byVisit)
}

/** Alt+j / Alt+k / Alt+l: the cycle after `current` (wrapping); the first one when it is elsewhere */
export function nextInCycle(
  ids: Array<string>,
  current: string,
  step = 1,
): string | undefined {
  const others = ids.filter((id) => id !== current)
  if (!others.length) return undefined
  const at = ids.indexOf(current)
  if (at < 0) return step > 0 ? ids[0] : ids.at(-1)
  return ids[(at + step + ids.length) % ids.length]
}
