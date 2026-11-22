package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSessionReferenceGivesAnAgentWhatItNeeds(t *testing.T) {
	home, _ := os.UserHomeDir()
	transcript := filepath.Join(home, ".claude", "projects", "-x", "abc-1.jsonl")
	e := attentionEntry{SessionID: "abc-1", AgentName: "fe1-c4", GitBranch: "master",
		TmuxSocket: "/tmp/tmux-1000/default", TmuxSession: "wezterm_work_fe1", TmuxPane: "%21"}
	ref := sessionReference(e, transcript, "claude")
	for _, want := range []string{
		"[wezdeck 会话] fe1-c4（claude）",
		"session_id: abc-1",
		"transcript: ~/.claude/projects/-x/abc-1.jsonl",
		"tmux: -S /tmp/tmux-1000/default -t %21（会话 wezterm_work_fe1）",
	} {
		if !strings.Contains(ref, want) {
			t.Fatalf("reference lacks %q:\n%s", want, ref)
		}
	}
	if strings.Contains(sessionReference(attentionEntry{SessionID: "x-2", WindowName: "w"}, "", ""), "transcript:") {
		t.Fatal("no transcript line without a transcript")
	}
}
