// One row of the host's `sessions` answer (native remote_session.go
// sessionCard): a live or archived agent session with its pane and the
// repo / worktree it runs in. Split out of console-sessions.tsx, which sits
// at the file-size limit; it re-exports the type for its importers.
import type { BgTask } from './session-background'

export type SessionCard = {
  id: string
  agent: string
  name: string
  /** Auto or /rename title from Claude aiTitle / Grok summary. */
  title?: string
  window: string
  cwd: string
  branch: string
  status: string
  waiting_kind?: string
  last_prompt: string
  ts: number
  transcript: boolean
  desk_idle_s: number
  running_kind?: string
  restart_pending?: boolean
  background?: Array<BgTask>
  /** Repo family label (git main checkout basename). */
  repo?: string
  /** repo through WEZDECK_REPO_ALIASES, as on the desk (wezterm-config → wezdeck) */
  repo_label?: string
  /** Absolute path of the git main checkout when known. */
  repo_root?: string
  /** Absolute path of this worktree (grouping key with repo_root). */
  worktree?: string
  /** The workstation's one-line purpose (git branch description). */
  worktree_description?: string
  tmux_session?: string
  tmux_pane?: string
  pane_index?: number
  /** primary | secondary when mounted in tmux; absent for future ticket agents. */
  pane_role?: string
  /** last visit to this worktree at the desk (ms, access ledger behind Alt+g) */
  visited?: number
  /** managed profile on the pane (claude_kimi, …); avatar corner badge */
  agent_profile?: string
}
