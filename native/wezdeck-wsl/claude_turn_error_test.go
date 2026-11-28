package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestClaudeAPIErrorSettlesOnlyCurrentTurn(t *testing.T) {
	path := filepath.Join(t.TempDir(), "claude.jsonl")
	write := func(lines ...string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	const user = `{"type":"user","timestamp":"2026-11-28T06:38:42.355Z","message":{"role":"user","content":"go"}}`
	const failed = `{"type":"assistant","timestamp":"2026-11-28T06:38:43.756Z","isApiErrorMessage":true,"message":{"role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"API Error: unavailable"}]}}`
	write(user, failed)
	started := int64(1795847922408)
	entry := attentionEntry{Status: "running", TurnStarted: started}
	if got := settleClaudeAPIError(entry, path, "claude"); got.Status != "done" || got.TS != 1795847923756 {
		t.Fatalf("current API error did not end at error time: %+v", got)
	}
	if got := settleClaudeAPIError(entry, path, "codex"); got.Status != "running" {
		t.Fatalf("other agent changed to %s", got.Status)
	}
	if got := settleClaudeAPIError(attentionEntry{Status: "running", TurnStarted: started + 2000}, path, "claude"); got.Status != "running" {
		t.Fatalf("old API error changed new turn to %s", got.Status)
	}
	write(user, failed, `{"type":"user","timestamp":"2026-11-28T06:39:00Z","message":{"role":"user","content":"retry"}}`)
	if got := settleClaudeAPIError(entry, path, "claude"); got.Status != "running" {
		t.Fatalf("retry remained %s", got.Status)
	}
}
