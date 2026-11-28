package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolveManagerProfile(t *testing.T) {
	settings := t.TempDir()
	t.Setenv("WEZDECK_AGENT_PROFILE_SETTINGS_DIR", settings)
	t.Setenv("MANAGED_AGENT_PROFILE", "codex")
	profile, err := resolveManagerProfile("")
	if err != nil || profile != "codex" {
		t.Fatalf("default profile = %q, %v", profile, err)
	}
	if err := os.WriteFile(filepath.Join(settings, "claude.json"), []byte(`{"disabled":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := resolveManagerProfile("claude"); err == nil || !strings.Contains(err.Error(), "disabled") {
		t.Fatalf("disabled profile: %v", err)
	}
}

func TestManagerPaneActiveRequiresTicketAndAgent(t *testing.T) {
	dir := t.TempDir()
	script := "#!/bin/sh\nprintf '%s\\t%s\\n' \"$TEST_TICKET\" \"$TEST_COMMAND\"\n"
	if err := os.WriteFile(filepath.Join(dir, "tmux"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("TEST_TICKET", "req-20261123-063230-90db23")
	t.Setenv("TEST_COMMAND", "codex")
	ms := &managerSessionMeta{State: "live", TmuxPane: "%195"}
	if !managerPaneActive("req-20261123-063230-90db23", ms) {
		t.Fatal("agent pane should be active")
	}
	if managerPaneActive("req-20261123-063230-other", ms) {
		t.Fatal("pane for another ticket should not be active")
	}
	t.Setenv("TEST_COMMAND", "zsh")
	if managerPaneActive("req-20261123-063230-90db23", ms) {
		t.Fatal("shell pane should not be active")
	}
}

func TestCollabManagerChatTreatsShellAsParked(t *testing.T) {
	root := t.TempDir()
	t.Setenv("TICKETS_ROOT", root)
	id := "req-20261123-063230-90db23"
	dataDir := filepath.Join(root, "_data", id)
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatal(err)
	}
	meta := `{"manager_session":{"backend":"claude","profile":"claude","id":"","tmux_pane":"%195","state":"live"}}`
	if err := os.WriteFile(filepath.Join(dataDir, "meta.json"), []byte(meta), 0o600); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	script := "#!/bin/sh\nprintf '%s\\t%s\\n' '" + id + "' zsh\n"
	if err := os.WriteFile(filepath.Join(dir, "tmux"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	res, err := collabManagerChat(json.RawMessage(`{"id":"` + id + `"}`))
	if err != nil {
		t.Fatal(err)
	}
	if state := res.(map[string]any)["state"]; state != "parked" {
		t.Fatalf("stale shell state = %v", state)
	}
}

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

func TestReplyArgv_ProposalBackends(t *testing.T) {
	argv, err := replyArgv(ticketReply{
		ID:       "req-20261127-140001-mgr001",
		Proposal: "p1",
		Verdict:  "approve",
		Backends: map[string]string{"b": "codex", "a": "claude"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := []string{"fanout", "approve", "--parent", "req-20261127-140001-mgr001", "--proposal", "p1", "--run", "--backends", "a=claude,b=codex"}
	if len(argv) != len(want) {
		t.Fatalf("argv=%v want=%v", argv, want)
	}
	for i := range want {
		if argv[i] != want[i] {
			t.Fatalf("argv[%d]=%q want %q", i, argv[i], want[i])
		}
	}
	if _, err := replyArgv(ticketReply{
		ID:       "req-20261127-140001-mgr001",
		Proposal: "p1",
		Verdict:  "approve",
		Backends: map[string]string{"a": "evil"},
	}); err == nil {
		t.Fatal("expected error for unsupported backend override")
	}
}

func TestCloseTicket_InvalidID(t *testing.T) {
	for _, raw := range []string{`{}`, `{"id":""}`, `{"id":"../etc/passwd"}`, `{"id":"bad id"}`} {
		if _, err := closeTicket(json.RawMessage(raw)); err == nil {
			t.Fatalf("expected invalid ticket id error for %s", raw)
		}
	}
}
