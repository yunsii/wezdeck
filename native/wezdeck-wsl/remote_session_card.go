package main

// sessionCard is the host's flat session-list contract. The web groups these
// cards by repo and worktree, then orders groups by OrderAt.
type sessionCard struct {
	ID                  string   `json:"id"`
	Agent               string   `json:"agent"`
	Name                string   `json:"name"`
	Title               string   `json:"title,omitempty"`
	Window              string   `json:"window"`
	Cwd                 string   `json:"cwd"`
	Branch              string   `json:"branch"`
	Status              string   `json:"status"`
	WaitingKind         string   `json:"waiting_kind,omitempty"`
	LastPrompt          string   `json:"last_prompt"`
	TS                  int64    `json:"ts"`
	TimeSource          string   `json:"time_source"`
	OrderAt             int64    `json:"order_at"`
	OrderSource         string   `json:"order_source"`
	Transcript          bool     `json:"transcript"`
	DeskIdleS           int64    `json:"desk_idle_s"`
	RunningKind         string   `json:"running_kind,omitempty"`
	RestartPending      bool     `json:"restart_pending,omitempty"`
	Background          []bgTask `json:"background"`
	Repo                string   `json:"repo,omitempty"`
	RepoLabel           string   `json:"repo_label,omitempty"`
	RepoRoot            string   `json:"repo_root,omitempty"`
	Worktree            string   `json:"worktree,omitempty"`
	WorktreeDescription string   `json:"worktree_description,omitempty"`
	TmuxSession         string   `json:"tmux_session,omitempty"`
	TmuxPane            string   `json:"tmux_pane,omitempty"`
	PaneIndex           int      `json:"pane_index,omitempty"`
	PaneRole            string   `json:"pane_role,omitempty"`
	Visited             int64    `json:"visited,omitempty"`
	AgentProfile        string   `json:"agent_profile,omitempty"`
	Detached            bool     `json:"detached,omitempty"`
	TicketID            string   `json:"ticket_id,omitempty"`
}

func sessionOrderAt(e attentionEntry, fallback int64) int64 {
	if e.archivedOrderAt > 0 {
		return e.archivedOrderAt
	}
	if (e.Status == "running" || e.Status == "waiting") && e.TurnStarted > 0 {
		return e.TurnStarted
	}
	if e.Status == "done" && e.TS > 0 {
		return e.TS
	}
	return fallback
}

func sessionOrderSource(e attentionEntry, fallbackSource string) string {
	if e.archivedOrderAt > 0 {
		return "archived_live"
	}
	if (e.Status == "running" || e.Status == "waiting") && e.TurnStarted > 0 {
		return "turn_started"
	}
	if e.Status == "done" && e.TS > 0 {
		return "completion"
	}
	return fallbackSource
}

func sessionFallbackTime(attentionAt, windowAt int64) (int64, string) {
	if attentionAt > 0 || windowAt <= 0 {
		return attentionAt, "attention"
	}
	return windowAt, "window_activity"
}
