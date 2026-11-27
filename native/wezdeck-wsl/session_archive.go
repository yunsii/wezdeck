package main

import (
	"strings"
	"time"
)

// Match the Web list's grace period for a turn that just finished.
const recentFinishedSession = 3 * time.Minute

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
