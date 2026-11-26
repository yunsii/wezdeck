package main

import "testing"

func TestPaneOwnsSessionAgent(t *testing.T) {
	tests := []struct {
		name, cmd, profile, archived string
		want                         bool
	}{
		{"fresh agy rejects old grok", "agy", "agy", "grok", false},
		{"grok wrapper keeps grok", "python3", "grok", "grok", true},
		{"claude variant keeps claude", "claude", "claude_kimi", "claude", true},
		{"unknown transcript stays", "agy", "agy", "other", true},
		{"unknown pane stays", "bash", "", "grok", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := paneOwnsSessionAgent(tt.cmd, tt.profile, tt.archived); got != tt.want {
				t.Fatalf("got %t want %t", got, tt.want)
			}
		})
	}
}

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
