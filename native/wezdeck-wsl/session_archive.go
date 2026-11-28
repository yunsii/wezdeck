package main

import (
	"strings"
	"time"
)

// Match the Web list's grace period for a turn that just finished.
const recentFinishedSession = 3 * time.Minute

func (e attentionEntry) asReadOnly() attentionEntry {
	e.Status = "idle"
	e.RunningKind = ""
	e.WaitingKind = ""
	e.RestartPending = false
	return e
}

func archivedCodexTranscript(r recentEntry) string {
	if r.LastStatus != "done" || r.ArchivedTS <= 0 || !sessionIDPattern.MatchString(r.SessionID) || isPendingSessionID(r.SessionID) {
		return ""
	}
	if fam := profileFamily(strings.ToLower(strings.TrimSpace(r.AgentName))); fam != "" && fam != "codex" {
		return ""
	}
	if path, agent := findTranscript(r.SessionID); agent == "codex" {
		return path
	}
	return ""
}

func archivedCodexCard(r recentEntry, path string) sessionCard {
	return sessionCard{
		ID: r.SessionID, Name: r.AgentName, Title: resolveSessionTitle(r.SessionID, path, "codex"),
		Window: r.WindowName, Branch: r.GitBranch, Status: "idle", Agent: "codex",
		Transcript: true, LastPrompt: r.LastUserPrompt, TS: r.ArchivedTS, TimeSource: "archived_at",
		OrderAt: r.LiveTS, OrderSource: "archived_live", DeskIdleS: -1,
	}
}

// Keep a stopped Claude conversation reachable when its original worktree
// window was restored as a shell (for example, its profile is now disabled).
// The window name and recorded cwd must both match; a reused pane id alone
// cannot establish ownership after tmux restarts.
func restoredShellTranscript(r recentEntry, panes map[string]tmuxPaneSnap) (string, string, string) {
	if r.SessionID == "" || r.ClearedTo != "" || r.TmuxSocket == "" || r.TmuxSession == "" || r.WindowName == "" {
		return "", "", ""
	}
	for key, pane := range panes {
		if !strings.HasPrefix(key, r.TmuxSocket+"|") || pane.session != r.TmuxSession || pane.windowName != r.WindowName {
			continue
		}
		if pane.cmd != "bash" && pane.cmd != "zsh" && pane.cmd != "sh" {
			continue
		}
		if paneHasAgentProcess(r.TmuxSocket, pane.id) {
			continue
		}
		path, agent := findTranscript(r.SessionID)
		cwd := transcriptCwd(path)
		if agent == "claude" && cwd != "" && cwd == pane.cwd {
			return path, agent, cwd
		}
	}
	return "", "", ""
}

func restoredShellCard(r recentEntry, path, agent, cwd string) sessionCard {
	repo, root, tree := gitRepoMeta(cwd)
	activity := lastTurnAt(path, agent)
	timeSource := "transcript_turn"
	if activity == 0 {
		activity = r.ArchivedTS
		timeSource = "archived_at"
	}
	return sessionCard{
		ID: r.SessionID, Name: r.AgentName, Title: resolveSessionTitle(r.SessionID, path, agent),
		Window: r.WindowName, Branch: r.GitBranch, Status: "idle", Agent: agent,
		Transcript: true, LastPrompt: r.LastUserPrompt, TS: activity, TimeSource: timeSource,
		OrderAt: activity, OrderSource: timeSource, DeskIdleS: -1,
		Cwd: cwd, Repo: repo, RepoRoot: root, Worktree: tree, TmuxSession: r.TmuxSession,
	}
}
