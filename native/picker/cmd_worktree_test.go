package main

import (
	"strings"
	"testing"
)

func TestWorktreeRenderHighlightsSelectedRow(t *testing.T) {
	ui := &worktreeUI{
		rows: []worktreeRow{
			{label: "main", path: "/repo", branch: "master", existingWindowID: "@1", accelerator: "1"},
			{label: "feature", path: "/repo-feat", branch: "feat", existingWindowID: "", accelerator: "2"},
		},
		selected:            1,
		currentWorktreeRoot: "/repo",
		repoLabel:           "wezterm-config",
	}

	out := captureStdout(t, func() { ui.render() })

	const selectedBg = "\x1b[48;5;255m"
	// Rows start at screen line 4; selected index 1 lands on line 5.
	if !strings.Contains(out, "\x1b[5;1H"+selectedBg+"▶ ") {
		t.Fatalf("selected row does not start with background highlight: %q", out)
	}

	// The background must stay continuous to the end of the line: no full
	// SGR reset may appear before the clear-to-EOL on the selected row.
	selectedStart := strings.Index(out, "\x1b[5;1H"+selectedBg)
	if selectedStart < 0 {
		t.Fatalf("selected row not found: %q", out)
	}
	tail := out[selectedStart:]
	eol := strings.Index(tail, "\x1b[K")
	if eol < 0 {
		t.Fatalf("selected row clear-to-EOL not found: %q", out)
	}
	if strings.Contains(tail[:eol], "\x1b[0m") {
		t.Fatalf("selected row reset before clear-to-EOL would break continuous background: %q", tail[:eol])
	}

	// The unselected row (line 4) must not carry the highlight background.
	if strings.Contains(out, "\x1b[4;1H"+selectedBg) {
		t.Fatalf("unselected row unexpectedly highlighted: %q", out)
	}
}
