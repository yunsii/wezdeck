package main

import (
	"errors"
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
	// Rows start at screen line 5 (title / showing / path detail / blank);
	// selected index 1 lands on line 6.
	if !strings.Contains(out, "\x1b[6;1H"+selectedBg+"▶ ") {
		t.Fatalf("selected row does not start with background highlight: %q", out)
	}

	// The background must stay continuous to the end of the line: no full
	// SGR reset may appear before the clear-to-EOL on the selected row.
	selectedStart := strings.Index(out, "\x1b[6;1H"+selectedBg)
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

	// The unselected row (line 5) must not carry the highlight background.
	if strings.Contains(out, "\x1b[5;1H"+selectedBg) {
		t.Fatalf("unselected row unexpectedly highlighted: %q", out)
	}
}

func TestWorktreeRenderShowsSelectedDetail(t *testing.T) {
	ui := &worktreeUI{
		rows: []worktreeRow{
			{label: "main", path: "/home/yuns/github/wezterm-config", branch: "master", existingWindowID: "@1", accelerator: "1"},
			{label: "feature", path: "/tmp/feature-wt", branch: "feat/x", existingWindowID: "", accelerator: "2"},
		},
		selected:  1,
		repoLabel: "wezterm-config",
	}

	out := captureStdout(t, func() { ui.render() })
	if !strings.Contains(out, "/tmp/feature-wt · feat/x") {
		t.Fatalf("selected path·branch missing from detail line: %q", out)
	}
	if !strings.Contains(out, "Ctrl+y path") || !strings.Contains(out, "Ctrl+b branch") {
		t.Fatalf("footer missing copy hints: %q", out)
	}
}

func TestWorktreeCopySelectedPathAndBranch(t *testing.T) {
	var gotOpen, gotText string
	orig := writeClipboardText
	writeClipboardText = func(openScript, text string) error {
		gotOpen, gotText = openScript, text
		return nil
	}
	t.Cleanup(func() { writeClipboardText = orig })

	ui := &worktreeUI{
		rows: []worktreeRow{
			{label: "main", path: "/repo/main", branch: "feat/x", existingWindowID: "@1", accelerator: "1"},
		},
		selected:   0,
		repoLabel:  "repo",
		openScript: "/runtime/scripts/runtime/tmux-worktree-open.sh",
	}

	ui.copySelected("path")
	if gotOpen != ui.openScript || gotText != "/repo/main" {
		t.Fatalf("path copy args: open=%q text=%q", gotOpen, gotText)
	}
	if ui.flash != "copied path /repo/main" {
		t.Fatalf("path flash: got %q", ui.flash)
	}

	ui.copySelected("branch")
	if gotText != "feat/x" {
		t.Fatalf("branch copy text: got %q", gotText)
	}
	if ui.flash != "copied branch feat/x" {
		t.Fatalf("branch flash: got %q", ui.flash)
	}

	out := captureStdout(t, func() { ui.render() })
	if !strings.Contains(out, "copied branch feat/x") {
		t.Fatalf("branch flash not rendered: %q", out)
	}
}

func TestWorktreeCopySelectedEmptyBranch(t *testing.T) {
	called := false
	orig := writeClipboardText
	writeClipboardText = func(openScript, text string) error {
		called = true
		return nil
	}
	t.Cleanup(func() { writeClipboardText = orig })

	ui := &worktreeUI{
		rows:       []worktreeRow{{label: "main", path: "/repo", branch: ""}},
		selected:   0,
		openScript: "/runtime/tmux-worktree-open.sh",
	}
	ui.copySelected("branch")
	if called {
		t.Fatal("clipboard helper should not run for empty branch")
	}
	if ui.flash != "no branch to copy" {
		t.Fatalf("flash: got %q", ui.flash)
	}
}

func TestWorktreeCopySelectedReportsFailure(t *testing.T) {
	orig := writeClipboardText
	writeClipboardText = func(openScript, text string) error {
		return errors.New("boom")
	}
	t.Cleanup(func() { writeClipboardText = orig })

	ui := &worktreeUI{
		rows:       []worktreeRow{{label: "main", path: "/repo/main", branch: "master"}},
		selected:   0,
		openScript: "/runtime/tmux-worktree-open.sh",
	}
	ui.copySelected("path")
	if ui.flash != "copy failed" {
		t.Fatalf("flash on failure: got %q", ui.flash)
	}
}

func TestWriteClipboardTextDefaultResolvesSiblingScript(t *testing.T) {
	// Don't actually invoke bash/helper — only check the constructed
	// argv when openScript is empty (early error path).
	if err := writeClipboardTextDefault("", "x"); err == nil {
		t.Fatal("expected error for empty openScript")
	}
}

func TestWorktreeMoveClearsFlash(t *testing.T) {
	ui := &worktreeUI{
		rows: []worktreeRow{
			{label: "a", path: "/a", accelerator: "1"},
			{label: "b", path: "/b", accelerator: "2"},
		},
		selected: 0,
		flash:    "copied path",
	}
	ui.move(1)
	if ui.flash != "" {
		t.Fatalf("move should clear flash, got %q", ui.flash)
	}
	if ui.selected != 1 {
		t.Fatalf("selected after move: got %d", ui.selected)
	}
}

func TestTruncateRunes(t *testing.T) {
	if got := truncateRunes("hello", 10); got != "hello" {
		t.Fatalf("short string: %q", got)
	}
	if got := truncateRunes("hello-world", 8); got != "hello-w…" {
		t.Fatalf("truncated: %q", got)
	}
	if got := truncateRunes("ab", 1); got != "…" {
		t.Fatalf("max=1: %q", got)
	}
}
