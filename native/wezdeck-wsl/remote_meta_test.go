package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSessionMetaGroupsKnownValuesOnly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "s.jsonl")
	_ = os.WriteFile(path, []byte(`{"type":"user","timestamp":"2026-11-22T01:00:00Z","message":{"content":"hi"}}`+"\n"), 0o600)
	tr, err := loadTranscript(path, "claude")
	if err != nil {
		t.Fatal(err)
	}
	// a socket that does not exist: never ask the machine's real tmux server
	e := attentionEntry{SessionID: "s-1", Status: "done", AgentName: "demo", GitBranch: "main",
		TmuxSocket: filepath.Join(t.TempDir(), "no-tmux"), TmuxSession: "w", TmuxPane: "%9"}
	groups := sessionMeta(e, path, "claude", tr)
	got := map[string]map[string]string{}
	for _, g := range groups {
		got[g.Name] = map[string]string{}
		for _, r := range g.Rows {
			if r.Value == "" {
				t.Fatalf("empty value kept: %s.%s", g.Name, r.Key)
			}
			got[g.Name][r.Key] = r.Value
		}
	}
	if got["session"]["id"] != "s-1" || got["session"]["agent"] != "claude" {
		t.Fatalf("session group: %v", got["session"])
	}
	if got["transcript"]["messages"] != "1" || got["transcript"]["first_turn"] != "2026-11-22T01:00:00Z" ||
		got["transcript"]["last_turn"] == "" || got["transcript"]["path"] != path {
		t.Fatalf("transcript group: %v", got["transcript"])
	}
	if got["location"]["branch"] != "main" || got["location"]["pane"] != "gone" {
		t.Fatalf("location group: %v", got["location"])
	}
	if got["state"]["status"] != "done" {
		t.Fatalf("state group: %v", got["state"])
	}
}
