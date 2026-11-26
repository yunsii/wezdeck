package main

import (
	"os"
	"time"
)

// Match the Web list's grace period for a turn that just finished.
const recentFinishedSession = 3 * time.Minute

func archivedCodexTranscript(r recentEntry) string {
	if r.LastStatus != "done" || r.ArchivedTS <= 0 || !sessionIDPattern.MatchString(r.SessionID) {
		return ""
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return (codexAdapter{}).Locate(home, r.SessionID)
}

func archivedCodexCard(r recentEntry, path string) sessionCard {
	return sessionCard{
		ID: r.SessionID, Name: r.AgentName, Title: readSessionTitle(path, "codex"),
		Window: r.WindowName, Branch: r.GitBranch, Status: "idle", Agent: "codex",
		Transcript: true, LastPrompt: r.LastUserPrompt, TS: r.ArchivedTS, OrderAt: r.LiveTS, DeskIdleS: -1,
	}
}
