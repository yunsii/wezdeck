package main

import "testing"

func TestPickManagedAgentProfilePrefersVariant(t *testing.T) {
	got := pickManagedAgentProfile("claude", "claude_kimi", "agent-cli:claude_kimi")
	if got != "claude_kimi" {
		t.Fatalf("got %q want claude_kimi", got)
	}
	got = pickManagedAgentProfile("claude", "claude_kimi", "")
	if got != "claude_kimi" {
		t.Fatalf("window variant: got %q", got)
	}
	got = pickManagedAgentProfile("claude_kimi", "claude", "")
	if got != "claude_kimi" {
		t.Fatalf("pane variant: got %q", got)
	}
	got = pickManagedAgentProfile("codex", "", "agent-cli:codex")
	if got != "codex" {
		t.Fatalf("bare: got %q", got)
	}
	got = pickManagedAgentProfile("", "", "agent-cli:claude_sub2api")
	if got != "claude_sub2api" {
		t.Fatalf("role only: got %q", got)
	}
}
