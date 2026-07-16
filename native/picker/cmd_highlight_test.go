package main

import (
	"fmt"
	"strings"
	"testing"
)

// assertRowHighlight verifies that the row drawn at screen line `screenRow`
// carries the full-width selected-row background: it starts with the bg SGR
// right after its cursor-position escape, and no full reset (`\x1b[0m`)
// appears before the clear-to-EOL — a mid-row reset would drop the bg and
// leave the bar broken. `mustContain`, when non-empty, must appear in the
// row body. Shared by the command / links / attention highlight tests.
func assertRowHighlight(t *testing.T, out string, screenRow int, mustContain string) {
	t.Helper()
	const selectedBg = "\x1b[48;5;255m"
	pos := fmt.Sprintf("\x1b[%d;1H", screenRow)
	if !strings.Contains(out, pos+selectedBg+"▶ ") {
		t.Fatalf("row %d does not start with background highlight: %q", screenRow, out)
	}
	start := strings.Index(out, pos+selectedBg)
	tail := out[start:]
	eol := strings.Index(tail, "\x1b[K")
	if eol < 0 {
		t.Fatalf("row %d clear-to-EOL not found: %q", screenRow, out)
	}
	line := tail[:eol]
	if strings.Contains(line, "\x1b[0m") {
		t.Fatalf("row %d full reset before clear-to-EOL breaks continuous background: %q", screenRow, line)
	}
	if mustContain != "" && !strings.Contains(line, mustContain) {
		t.Fatalf("row %d body missing %q: %q", screenRow, mustContain, line)
	}
}

func TestCommandRenderHighlightsSelectedRow(t *testing.T) {
	ui := &commandUI{
		rows: []commandRow{
			{label: "First command", hotkeyDisplay: "Alt+a"},
			{label: "Second command", hotkeyDisplay: "Alt+b"},
		},
		filtered: []int{0, 1},
		selected: 1,
		mode:     "worktree",
	}
	out := captureStdout(t, func() { ui.render() })
	// Item rows start at screen line 5; selected index 1 lands on line 6.
	// The dim hotkey hint carries an inner reset that must be swapped so the
	// bar stays continuous.
	assertRowHighlight(t, out, 6, "Second command")
	if strings.Contains(out, "\x1b[5;1H\x1b[48;5;255m") {
		t.Fatalf("unselected command row unexpectedly highlighted: %q", out)
	}
}

func TestLinksRenderHighlightsSelectedRow(t *testing.T) {
	ui := &linksUI{
		rows: []linkRow{
			{title: "First", url: "https://a.example/one"},
			{title: "Second", url: "https://b.example/two"},
		},
		filtered: []int{0, 1},
		selected: 1,
	}
	out := captureStdout(t, func() { ui.render() })
	// Item rows start at screen line 5; selected index 1 lands on line 6.
	assertRowHighlight(t, out, 6, "Second")
	if strings.Contains(out, "\x1b[5;1H\x1b[48;5;255m") {
		t.Fatalf("unselected link row unexpectedly highlighted: %q", out)
	}
}

func TestAttentionRenderHighlightsSelectedRow(t *testing.T) {
	rows := []attentionRow{
		{
			status: "waiting", workspace: "config", tab: "1_wezterm-config",
			branch: "master", tmuxSeg: "1_2", reason: "needs input",
			age: "5m", isCurrent: true,
		},
		{
			status: "done", workspace: "work", tab: "2_other",
			branch: "feat", tmuxSeg: "2_1", reason: "task done", age: "1m",
		},
	}
	cols := attentionColWidths{workspace: 8, tab: 18, tmuxSeg: 4, branch: 10}
	out := captureStdout(t, func() {
		renderAttentionFrame(rows, 1, perfTimings{}, "", "all", cols, "config")
	})
	// Item rows start at screen line 4; selected index 1 lands on line 5.
	// This row has several inner resets (colored badge, workspace cell,
	// branch/pane separator, dim age) — the assertion catches any that were
	// not rewritten to the bg-preserving restore.
	assertRowHighlight(t, out, 5, "task done")
	if strings.Contains(out, "\x1b[4;1H\x1b[48;5;255m") {
		t.Fatalf("unselected attention row unexpectedly highlighted: %q", out)
	}
}
