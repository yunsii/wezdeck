package main

import (
	"errors"
	"os"
	"path/filepath"
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
	if !strings.Contains(out, "Ctrl+d reclaim") {
		t.Fatalf("footer missing reclaim hint: %q", out)
	}
}

func TestWorktreeBeginReclaimConfirm(t *testing.T) {
	ui := &worktreeUI{
		rows: []worktreeRow{
			{label: "main", path: "/home/yuns/work/coco-forge", branch: "master", accelerator: "1"},
			{label: "dev-x", path: "/home/yuns/work/.worktrees/coco-forge/dev-x", branch: "dev/x", accelerator: "2"},
			{label: "task-y", path: "/home/yuns/work/.worktrees/coco-forge/task-y", branch: "task/y", accelerator: "3"},
		},
		selected: 0,
	}
	ui.beginReclaimConfirm()
	if ui.pendingReclaim != "" || ui.flash != "refusing primary worktree" {
		t.Fatalf("primary: pending=%q flash=%q", ui.pendingReclaim, ui.flash)
	}

	ui.flash = ""
	ui.selected = 1
	ui.beginReclaimConfirm()
	if ui.pendingReclaim != "Reclaim long-lived dev-x?" {
		t.Fatalf("dev confirm: got %q", ui.pendingReclaim)
	}

	ui.pendingReclaim = ""
	ui.selected = 2
	ui.beginReclaimConfirm()
	if ui.pendingReclaim != "Reclaim task-y?" {
		t.Fatalf("task confirm: got %q", ui.pendingReclaim)
	}
}

func TestWorktreeReclaimSelectedRemovesRow(t *testing.T) {
	orig := runWorktreeReclaim
	runWorktreeReclaim = func(openScript, sessionName, worktreePath, sourceWindowID, cwd string) (string, string, error) {
		if worktreePath != "/repo/.worktrees/r/task-a" {
			t.Fatalf("path: %q", worktreePath)
		}
		return "OK", "task-a", nil
	}
	t.Cleanup(func() { runWorktreeReclaim = orig })

	ui := &worktreeUI{
		rows: []worktreeRow{
			{label: "task-a", path: "/repo/.worktrees/r/task-a", branch: "task/a", accelerator: "1"},
			{label: "task-b", path: "/repo/.worktrees/r/task-b", branch: "task/b", accelerator: "2"},
		},
		selected:   0,
		openScript: "/runtime/scripts/runtime/tmux-worktree-open.sh",
	}
	if !ui.reclaimSelected() {
		t.Fatal("expected row removal")
	}
	if len(ui.rows) != 1 || ui.rows[0].label != "task-b" {
		t.Fatalf("rows after reclaim: %+v", ui.rows)
	}
	if ui.rows[0].accelerator != "1" {
		t.Fatalf("accelerator not reassigned: %q", ui.rows[0].accelerator)
	}
	if ui.flash != "reclaimed task-a" {
		t.Fatalf("flash: %q", ui.flash)
	}
}

func TestWorktreeReclaimSelectedRefuseKeepsRow(t *testing.T) {
	orig := runWorktreeReclaim
	runWorktreeReclaim = func(openScript, sessionName, worktreePath, sourceWindowID, cwd string) (string, string, error) {
		return "REFUSE", "task-a has uncommitted changes", nil
	}
	t.Cleanup(func() { runWorktreeReclaim = orig })

	ui := &worktreeUI{
		rows: []worktreeRow{
			{label: "task-a", path: "/repo/.worktrees/r/task-a", branch: "task/a", accelerator: "1"},
		},
		selected:   0,
		openScript: "/runtime/scripts/runtime/tmux-worktree-open.sh",
	}
	if ui.reclaimSelected() {
		t.Fatal("refuse should not report list change")
	}
	if len(ui.rows) != 1 {
		t.Fatalf("row count: %d", len(ui.rows))
	}
	if ui.flash != "task-a has uncommitted changes" {
		t.Fatalf("flash: %q", ui.flash)
	}
}

func TestWorktreeRenderReclaimConfirm(t *testing.T) {
	ui := &worktreeUI{pendingReclaim: "Reclaim task-a?"}
	out := captureStdout(t, func() { ui.render() })
	if !strings.Contains(out, "Reclaim task-a?") {
		t.Fatalf("confirm title missing: %q", out)
	}
	if !strings.Contains(out, "Enter / y confirm") {
		t.Fatalf("confirm hint missing: %q", out)
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

func TestLoadWorktreeRowsParsesAttentionColumns(t *testing.T) {
	// menu.sh emits 7 columns; the last three are the agent-attention
	// join. Reason may contain spaces (and `·`), never tabs — menu.sh's
	// jq strips those.
	path := filepath.Join(t.TempDir(), "prefetch.tsv")
	body := "main\t/repo\tmaster\t@1\trunning\t12s\t\n" +
		"dev-auth\t/repo-auth\tdev/auth\t@2\twaiting\t2m\tneeds your permission to use Bash\n" +
		"task-perf\t/repo-perf\ttask/perf\t@3\tdone\t3m\ttask done\n" +
		"hotfix-x\t/repo-hot\thotfix/x\t\t\t\t\n"
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}

	rows, err := loadWorktreeRows(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 4 {
		t.Fatalf("row count: got %d", len(rows))
	}
	if rows[1].status != "waiting" || rows[1].age != "2m" ||
		rows[1].reason != "needs your permission to use Bash" {
		t.Fatalf("waiting row: %+v", rows[1])
	}
	if rows[2].status != "done" || rows[2].age != "3m" {
		t.Fatalf("done row: %+v", rows[2])
	}
	if rows[3].status != "" || rows[3].existingWindowID != "" {
		t.Fatalf("worktree with no window should carry no status: %+v", rows[3])
	}
	if rows[0].accelerator != "1" || rows[1].accelerator != "2" {
		t.Fatalf("accelerators did not survive the wider TSV: %+v", rows[:2])
	}
}

func TestLoadWorktreeRowsToleratesLegacyFourColumns(t *testing.T) {
	path := filepath.Join(t.TempDir(), "prefetch.tsv")
	if err := os.WriteFile(path, []byte("main\t/repo\tmaster\t@1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	rows, err := loadWorktreeRows(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].existingWindowID != "@1" || rows[0].status != "" {
		t.Fatalf("legacy 4-column row: %+v", rows)
	}
}

func TestWorktreeRenderShowsAgentStatusColumn(t *testing.T) {
	ui := &worktreeUI{
		rows: []worktreeRow{
			{label: "main", path: "/repo", branch: "master", existingWindowID: "@1", accelerator: "1",
				status: "running", age: "12s"},
			{label: "dev-auth", path: "/repo-auth", branch: "dev/auth", existingWindowID: "@2", accelerator: "2",
				status: "waiting", age: "2m", reason: "needs your permission to use Bash"},
			{label: "task-perf", path: "/repo-perf", branch: "task/perf", existingWindowID: "@3", accelerator: "3",
				status: "done", age: "3m", reason: "task done"},
			// No window: last-visit age only (not "(new)").
			{label: "hotfix-x", path: "/repo-hot", branch: "hotfix/x", accelerator: "4", age: "2d"},
			// No window and no visit history: blank status cell.
			{label: "orphan", path: "/repo-orphan", branch: "misc", accelerator: "5"},
		},
		selected:            1,
		currentWorktreeRoot: "/repo-auth",
		repoLabel:           "wezterm-config",
	}

	out := captureStdout(t, func() { ui.render() })

	for _, want := range []string{"● 12s", "▲ 2m", "✓ 3m", "2d"} {
		if !strings.Contains(out, want) {
			t.Fatalf("status cell %q missing: %q", want, out)
		}
	}
	// Live cells are never dimmed — only last-visit age is.
	if strings.Contains(out, "\x1b[2m✓ 3m") {
		t.Fatalf("live status cell should not be dimmed: %q", out)
	}
	if !strings.Contains(out, "\x1b[2m2d") {
		t.Fatalf("last-visit age is not dimmed: %q", out)
	}
	if strings.Contains(out, "(new)") {
		t.Fatalf("unexpected (new) hint: %q", out)
	}
	// Detail line carries the focused row's reason so the user knows why
	// it is ▲ before jumping.
	if !strings.Contains(out, "/repo-auth · dev/auth · needs your permission to use Bash") {
		t.Fatalf("detail line missing reason: %q", out)
	}
	// Name cells are padded to a common width so the status column aligns:
	// the longest cell here is "task-perf [task/perf]" (21 runes).
	if !strings.Contains(out, "main [master]        ") {
		t.Fatalf("name column not padded for status alignment: %q", out)
	}
}

func TestWorktreeArchivedStatusRendersNothing(t *testing.T) {
	// Regression lock for 2026-07-27: menu.sh no longer joins recent[]
	// tombstones, because a 7-day-lived `last ● 4h` contradicted every
	// wezterm surface (badge / counters read live .entries only). If some
	// producer ever emits the old `last:<status>` form again, the cell
	// stays empty rather than resurrecting stale state on the row.
	for _, status := range []string{"last:done", "last:running", "recent", "bogus"} {
		r := worktreeRow{label: "task-perf", existingWindowID: "@3", status: status, age: "4h"}
		if got := r.statusCell("\x1b[0m"); got != "" {
			t.Fatalf("status %q should render no cell, got %q", status, got)
		}
	}
}

func TestWorktreeSelectedRowKeepsBackgroundThroughDimStatus(t *testing.T) {
	// The dim run in the last-visit-age status cell must restore with the
	// background-preserving SGR, not a full reset — otherwise the
	// selected row's highlight bar stops mid-line.
	ui := &worktreeUI{
		rows: []worktreeRow{
			{label: "task-perf", path: "/repo-perf", branch: "task/perf",
				accelerator: "1", age: "3h"},
		},
		selected:  0,
		repoLabel: "wezterm-config",
	}
	out := captureStdout(t, func() { ui.render() })
	start := strings.Index(out, "\x1b[5;1H\x1b[48;5;255m")
	if start < 0 {
		t.Fatalf("selected row not found: %q", out)
	}
	tail := out[start:]
	eol := strings.Index(tail, "\x1b[K")
	if eol < 0 {
		t.Fatalf("clear-to-EOL not found: %q", out)
	}
	if strings.Contains(tail[:eol], "\x1b[0m") {
		t.Fatalf("dim status cell reset the selected background: %q", tail[:eol])
	}
	if !strings.Contains(tail[:eol], "\x1b[22;23;24;27;39m") {
		t.Fatalf("dim status cell did not restore with the bg-preserving SGR: %q", tail[:eol])
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
