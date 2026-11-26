package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAgyTranscriptAdapter(t *testing.T) {
	home := t.TempDir()
	id := "11111111-2222-4333-8444-555555555555"
	path := filepath.Join(home, ".gemini", "antigravity-cli", "brain", id,
		".system_generated", "logs", "transcript_full.jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	data := strings.Join([]string{
		`{"type":"USER_INPUT","source":"USER_EXPLICIT","content":"Read sample.txt","created_at":"2026-11-26T07:57:37Z"}`,
		`{"type":"PLANNER_RESPONSE","source":"MODEL","created_at":"2026-11-26T07:57:38Z","model":"gemini-4-neon-medium","input_tokens":12,"cache_read_tokens":3,"output_tokens":7,"tool_calls":[{"name":"read_file","args":{"path":"sample.txt"}}]}`,
		`{"type":"GENERIC","source":"MODEL","content":"tool output","created_at":"2026-11-26T07:57:39Z"}`,
		`{"type":"PLANNER_RESPONSE","source":"MODEL","content":"OK","created_at":"2026-11-26T07:57:40Z","model":"gemini-4-neon-medium","input_tokens":20,"cache_read_tokens":4,"output_tokens":2}`,
	}, "\n") + "\n"
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	adapter := agyAdapter{}
	if got := adapter.Locate(home, id); got != path {
		t.Fatalf("Locate: %q", got)
	}
	if got := adapter.Locate(home, "missing"); got != "" {
		t.Fatalf("missing transcript: %q", got)
	}
	tr, err := loadTranscript(path, "agy")
	if err != nil {
		t.Fatal(err)
	}
	if len(tr.messages) != 3 || tr.messages[0].Role != "user" || tr.messages[1].Tool != "read_file" || tr.messages[1].Kind != toolKindRead || tr.messages[1].Pending || tr.messages[2].Text != "OK" {
		t.Fatalf("messages: %+v", tr.messages)
	}
	if tr.usage.Model != "gemini-4-neon-medium" || tr.usage.Context != 24 || tr.usage.Output != 9 || tr.usage.Turns != 2 {
		t.Fatalf("usage: %+v", tr.usage)
	}
	if got := adapter.Title(path); got != "Read sample.txt" {
		t.Fatalf("title: %q", got)
	}
	if got := lastTurnAt(path, "agy"); got == 0 {
		t.Fatal("Agy last turn was not parsed")
	}
	users, files, last := handoffTranscriptDigest(path, "agy")
	if len(users) != 1 || users[0] != "Read sample.txt" || len(files) != 1 || files[0] != "sample.txt" || last != "OK" {
		t.Fatalf("handoff digest: users=%v files=%v last=%q", users, files, last)
	}
}

func TestAgyWorkspaceTrustIsExact(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	path := filepath.Join(home, ".gemini", "antigravity-cli", "settings.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"trustedWorkspaces":["/repo"]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if !agyWorkspaceTrusted("/repo") || agyWorkspaceTrusted("/repo/new-worktree") {
		t.Fatal("Agy trust must be confirmed for each worktree")
	}
}
