package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestCollabManagerChat_ParkedHistoryAndTicketIDDetection(t *testing.T) {
	ticketsRoot := t.TempDir()
	home := t.TempDir()
	t.Setenv("TICKETS_ROOT", ticketsRoot)
	t.Setenv("HOME", home)

	tid := "req-20261127-140001-mgr001"
	wsPath := filepath.Join(ticketsRoot, "workspaces", tid)
	if got := ticketIDFromCwd(wsPath); got != tid {
		t.Fatalf("expected ticketIDFromCwd=%s, got %q", tid, got)
	}
	if got := ticketIDFromCwd(filepath.Join(home, "github", "wezdeck")); got != "" {
		t.Fatalf("expected empty ticket id for normal repo cwd, got %q", got)
	}

	// Create a Claude transcript for a parked manager session
	sessID := "mgr-sess-parked-1"
	projDir := filepath.Join(home, ".claude", "projects", "-tmp-mgr")
	if err := os.MkdirAll(projDir, 0o755); err != nil {
		t.Fatal(err)
	}
	trLines := `{"type":"user","message":{"role":"user","content":"Split auth migration across repos"}}
{"type":"assistant","message":{"id":"a1","role":"assistant","content":[{"type":"text","text":"Prepared 4-part proposal for your review."}]}}
`
	if err := os.WriteFile(filepath.Join(projDir, sessID+".jsonl"), []byte(trLines), 0o644); err != nil {
		t.Fatal(err)
	}

	tDir := filepath.Join(ticketsRoot, "_data", tid)
	if err := os.MkdirAll(tDir, 0o755); err != nil {
		t.Fatal(err)
	}
	metaJSON, _ := json.Marshal(map[string]any{
		"kind": "parent",
		"manager_session": map[string]any{
			"backend":      "claude",
			"profile":      "claude",
			"id":           sessID,
			"cwd":          wsPath,
			"tmux_session": "wezterm_collab_tickets",
			"tmux_window":  "ticket-mgr001",
			"tmux_pane":    "",
			"state":        "parked",
		},
	})
	if err := os.WriteFile(filepath.Join(tDir, "meta.json"), metaJSON, 0o644); err != nil {
		t.Fatal(err)
	}

	raw, err := collabManagerChat(json.RawMessage(`{"id":"` + tid + `"}`))
	if err != nil {
		t.Fatalf("collabManagerChat error: %v", err)
	}
	res := raw.(map[string]any)
	if res["state"] != "parked" {
		t.Fatalf("expected state=parked, got %v", res["state"])
	}
	msgs := res["messages"].([]chatMessage)
	if len(msgs) != 2 || msgs[1].Text != "Prepared 4-part proposal for your review." {
		t.Fatalf("unexpected parked manager messages: %+v", msgs)
	}
}
