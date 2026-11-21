// Pure row-model helpers for the Development console page (no React).
import type {
  AgentSession,
  VscodeWindow,
  WorkspaceCatalog,
} from '#/lib/runtime-contract'

export type Worktree = {
  path: string
  name: string
  branch: string
  kind: string
}

export type CatalogRow = {
  id: string
  workspace: string
  cwd: string
  name: string
  worktrees: Worktree[]
  /** Live attention entries for this repo (may be multiple worktree panes). */
  liveSessions: AgentSession[]
  /** Preferred detail/jump target: live first, else most recent archive. */
  session?: AgentSession
  recent: boolean
}

export function catalogRows(
  catalog: WorkspaceCatalog['workspaces'],
  entries: AgentSession[],
  recent: AgentSession[],
): CatalogRow[] {
  return catalog.flatMap((workspace) =>
    workspace.items.map((item) => {
      const liveSessions = entries.filter((entry) =>
        sessionMatches(entry, item),
      )
      const live = liveSessions.at(0)
      const archived = recent.find((entry) => sessionMatches(entry, item))
      const worktrees =
        item.worktrees.length > 0
          ? item.worktrees
          : [
              {
                path: item.cwd,
                name: item.name,
                branch: '',
                kind: 'primary',
              },
            ]
      return {
        id: workspace.name + ':' + item.cwd,
        workspace: workspace.name,
        cwd: item.cwd,
        name: item.name,
        worktrees,
        liveSessions,
        session: live ?? archived,
        recent: !live && Boolean(archived),
      }
    }),
  )
}

export function sessionMatches(
  entry: AgentSession,
  item: { cwd: string; name: string },
) {
  const repo = entry.repo || deriveRepo(entry.tmux_session)
  return repo === item.name
}

export function windowFor(windows: VscodeWindow[], name: string) {
  const match = windows.find((window) =>
    (window.title || window.Title || '').includes(name),
  )
  return match?.hwnd ?? match?.Hwnd
}

export function deriveRepo(session: string | undefined) {
  const match = session?.match(/^wezterm_[^_]+_(.+)_[0-9a-f]{10}$/i)
  return match?.[1] ?? ''
}
