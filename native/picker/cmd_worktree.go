// `picker worktree` — replaces tmux-worktree-picker.sh inside the popup
// pty. Reads a TSV menu.sh prefetched (with existing_window_id already
// resolved, so the popup pty does zero tmux RPCs at first paint) and
// fires `tmux-worktree-open.sh` via `tmux run-shell -b` so the popup
// tears down before the open work starts.
//
// Bindings:
//   Enter    → open selected worktree window
//   Ctrl+Y   → copy selected worktree path to the Windows clipboard
//   Ctrl+B   → copy selected branch name to the Windows clipboard
//   Up/Down  → move
//   1-9,0,a-z → accelerator open
//   Esc / Ctrl+C / Alt+g → close
//
// Clipboard writes go through agent-clipboard.sh / host helper — NOT OSC 52.
// Why keyboard copy instead of mouse select: plain drag is intentionally
// unbound (tmux pane-local select needs Shift+drag; terminal-wide select
// needs Super+drag). Inside a live raw-mode TUI popup, Shift+drag enters
// copy-mode and fights the picker's redraw, and Super is Win on hybrid-wsl
// so OS window chrome often steals it.
//
// Why not OSC 52: tmux `display-popup -E` does not forward OSC/DCS
// pass-through to the parent WezTerm client (same constraint that forced
// the attention picker's file event-bus). Emitting OSC 52 only paints a
// false "copied" flash. links-dispatch uses Set-Clipboard; we use the
// shared agent-clipboard helper (warm IPC is faster than a fresh
// powershell.exe).
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"golang.org/x/term"
)

type worktreeRow struct {
	label            string
	path             string
	branch           string
	existingWindowID string // empty when no tmux window for this worktree yet
	accelerator      string // single-char key, e.g. "1" or "a"; "" when out of slots
}

type worktreeUI struct {
	rows                []worktreeRow
	selected            int
	currentWorktreeRoot string
	repoLabel           string
	openScript          string
	sessionName         string
	currentWindowID     string
	cwd                 string
	ts                  perfTimings
	// flash is a one-shot status line (e.g. "copied path") shown on the
	// path row until the next move/render clears it.
	flash string
}

type worktreePicker struct{}

func (worktreePicker) Name() string { return "worktree" }

func (worktreePicker) Run(args []string) int {
	if len(args) < 7 {
		fmt.Fprintln(os.Stderr, "usage: picker worktree <prefetch_tsv> <open_script> <session_name> <current_window_id> <cwd> <current_worktree_root> <repo_label> [keypress_ts] [menu_start_ts] [menu_done_ts]")
		return 2
	}
	prefetchPath := args[0]
	openScript := args[1]
	sessionName := args[2]
	currentWindowID := args[3]
	cwd := args[4]
	currentRoot := args[5]
	repoLabel := args[6]
	ts := parsePerfTimings(args, 7)

	rows, err := loadWorktreeRows(prefetchPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "picker: %v\n", err)
		return 1
	}
	if len(rows) == 0 {
		fmt.Fprintf(os.Stderr, "picker: no worktrees for %s\n", repoLabel)
		return 1
	}

	// Pre-select the current worktree row so Enter on first paint = stay
	// (or with no current root, default to the first row).
	selected := 0
	for i, r := range rows {
		if r.path == currentRoot {
			selected = i
			break
		}
	}

	fd, state, ok := enterRawMode()
	if !ok {
		return 1
	}
	defer restoreRawMode(fd, state)

	ui := &worktreeUI{
		rows:                rows,
		selected:            selected,
		currentWorktreeRoot: currentRoot,
		repoLabel:           repoLabel,
		openScript:          openScript,
		sessionName:         sessionName,
		currentWindowID:     currentWindowID,
		cwd:                 cwd,
		ts:                  ts,
	}
	ui.render()
	// Once-per-popup perf event after the first frame's bytes hit stdout —
	// see docs/logging-conventions.md "Render-path discipline".
	ui.ts.emitFirstPaint("worktree.perf", "worktree", "worktree picker paint timing", len(ui.rows), ui.selected, nil)

	return runKeyLoop(func(key string) (loopAction, int) {
		switch key {
		case "\r", "\n":
			ui.dispatch(fd, state)
			return loopExit, 0
		case "\x19": // Ctrl+Y — copy focused path; stay open (unlike Enter)
			ui.copySelected("path")
			ui.render()
		case "\x02": // Ctrl+B — copy focused branch name; stay open
			ui.copySelected("branch")
			ui.render()
		case "\x1b", "\x03", "\x1bg":
			// Bare Esc / Ctrl+C / forwarded Alt+g (the chord that opened
			// this popup, treated as a toggle exit). Mirrors bash picker.
			return loopExit, 0
		case "\x1b[B", "\x1bOB":
			ui.move(1)
			ui.render()
		case "\x1b[A", "\x1bOA":
			ui.move(-1)
			ui.render()
		default:
			if i := ui.findAccelerator(key); i >= 0 {
				ui.selected = i
				ui.dispatch(fd, state)
				return loopExit, 0
			}
		}
		return loopContinue, 0
	})
}

func loadWorktreeRows(path string) ([]worktreeRow, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read prefetch %s: %w", path, err)
	}
	accels := []string{
		"1", "2", "3", "4", "5", "6", "7", "8", "9", "0",
		"a", "b", "c", "d", "e", "f", "g", "h", "i", "j",
		"k", "l", "m", "n", "o", "p", "q", "r", "s", "t",
		"u", "v", "w", "x", "y", "z",
	}
	var rows []worktreeRow
	for _, line := range strings.Split(strings.TrimRight(string(data), "\n"), "\n") {
		if line == "" {
			continue
		}
		// 4 fields: label  path  branch  existing_window_id
		parts := strings.SplitN(line, "\t", 4)
		if len(parts) < 4 {
			continue
		}
		row := worktreeRow{
			label:            parts[0],
			path:             parts[1],
			branch:           parts[2],
			existingWindowID: parts[3],
		}
		if len(rows) < len(accels) {
			row.accelerator = accels[len(rows)]
		}
		rows = append(rows, row)
	}
	return rows, nil
}

func (ui *worktreeUI) move(delta int) {
	n := len(ui.rows)
	if n == 0 {
		ui.selected = 0
		return
	}
	ui.selected = (ui.selected + delta) % n
	if ui.selected < 0 {
		ui.selected += n
	}
	ui.flash = ""
}

// copySelected writes path or branch of the focused row to the Windows
// clipboard through agent-clipboard.sh (sibling of the open script passed
// by tmux-worktree-menu.sh). Blocks until the helper returns so the flash
// reflects real success/failure. Stays open. kind is "path" or "branch".
func (ui *worktreeUI) copySelected(kind string) {
	if ui.selected < 0 || ui.selected >= len(ui.rows) {
		return
	}
	r := ui.rows[ui.selected]
	var text, emptyMsg, okPrefix string
	switch kind {
	case "branch":
		text, emptyMsg, okPrefix = r.branch, "no branch to copy", "copied branch "
	default: // path
		text, emptyMsg, okPrefix = r.path, "no path to copy", "copied path "
	}
	if text == "" {
		ui.flash = emptyMsg
		return
	}
	if err := writeClipboardText(ui.openScript, text); err != nil {
		ui.flash = "copy failed"
		return
	}
	// Keep the payload in the flash so the user can confirm what landed.
	ui.flash = okPrefix + text
}

// writeClipboardText invokes agent-clipboard.sh next to openScript.
// openScript is always scripts/runtime/tmux-worktree-open.sh in production;
// tests may override writeClipboardTextHook.
var writeClipboardText = writeClipboardTextDefault

func writeClipboardTextDefault(openScript, text string) error {
	if openScript == "" {
		return fmt.Errorf("open script path empty")
	}
	script := filepath.Join(filepath.Dir(openScript), "agent-clipboard.sh")
	cmd := exec.Command("bash", script, "write-text", "--text", text, "--quiet")
	// Detach from the popup pty so agent-clipboard / helperctl cannot
	// corrupt the raw-mode TUI if they write diagnostics to stdout.
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("agent-clipboard: %w", err)
	}
	return nil
}

func (ui *worktreeUI) findAccelerator(key string) int {
	if len(key) != 1 {
		return -1
	}
	k := strings.ToLower(key)
	for i, r := range ui.rows {
		if r.accelerator == k {
			return i
		}
	}
	return -1
}

func (ui *worktreeUI) render() {
	cols, lines := getTermSize()
	// Title + showing + path detail + blank + footer reserve ≈ 7 chrome lines
	// (rows start at screen line 5; one blank before footer).
	visibleRows := lines - 7
	if visibleRows < 1 {
		visibleRows = 1
	}
	itemCount := len(ui.rows)

	startIndex := 0
	if ui.selected >= visibleRows {
		startIndex = ui.selected - visibleRows + 1
	}
	endIndex := startIndex + visibleRows - 1
	if endIndex >= itemCount {
		endIndex = itemCount - 1
		startIndex = endIndex - visibleRows + 1
		if startIndex < 0 {
			startIndex = 0
		}
	}

	const reset = "\x1b[0m"
	const clearEOL = "\x1b[K"
	// Full-width selected-row highlight, mirroring cmd_overflow.go. The row
	// body carries no inner SGR color, so a bare background + trailing
	// clearEOL (which paints to EOL under the active bg) is enough — no
	// "selected variant" helpers like overflow needs for its colored cells.
	const selectedBg = "\x1b[48;5;255m"

	var b strings.Builder
	b.Grow(2048)

	// Title row.
	b.WriteString("\x1b[1;1H\x1b[1m")
	fmt.Fprintf(&b, "Worktrees: %s", ui.repoLabel)
	b.WriteString(reset)
	b.WriteString(clearEOL)

	// "Showing N-M of K" indicator.
	b.WriteString("\x1b[2;1H\x1b[2m")
	fmt.Fprintf(&b, "Showing %d-%d of %d", startIndex+1, endIndex+1, itemCount)
	b.WriteString(reset)
	b.WriteString(clearEOL)

	// Detail of the focused row (or post-copy flash): path · branch so
	// both copy targets are visible before Ctrl+y / Ctrl+b.
	b.WriteString("\x1b[3;1H")
	if ui.flash != "" {
		b.WriteString("\x1b[32m")
		b.WriteString(truncateRunes(ui.flash, cols))
		b.WriteString(reset)
	} else if ui.selected >= 0 && ui.selected < itemCount {
		b.WriteString("\x1b[2m")
		b.WriteString(truncateRunes(ui.selectedDetailLine(), cols))
		b.WriteString(reset)
	}
	b.WriteString(clearEOL)

	row := 5
	for i := startIndex; i <= endIndex; i++ {
		fmt.Fprintf(&b, "\x1b[%d;1H", row)
		r := ui.rows[i]
		marker := ' '
		if r.path == ui.currentWorktreeRoot {
			marker = '*'
		}
		accelText := "   "
		if r.accelerator != "" {
			accelText = "[" + r.accelerator + "]"
		}
		branch := ""
		if r.branch != "" {
			branch = " [" + r.branch + "]"
		}
		suffix := ""
		if r.existingWindowID == "" {
			suffix = " (new)"
		}
		if i == ui.selected {
			b.WriteString(selectedBg)
			b.WriteString("▶ ")
		} else {
			b.WriteString("  ")
		}
		fmt.Fprintf(&b, "%s %c %s%s%s", accelText, marker, r.label, branch, suffix)
		b.WriteString(clearEOL)
		if i == ui.selected {
			b.WriteString(reset)
		}
		row++
	}

	// Footer.
	row++
	fmt.Fprintf(&b, "\x1b[%d;1H", row)
	b.WriteString("\x1b[2mEnter open · Ctrl+y path · Ctrl+b branch · Up/Down · 1-9,0,a-z open · Esc close  ·  powered by ")
	b.WriteString("\x1b[22;1;38;5;108mgo")
	b.WriteString(reset)
	ui.ts.renderFooterTail(&b)
	b.WriteString(clearEOL)
	b.WriteString("\x1b[J")

	_, _ = os.Stdout.WriteString(b.String())
}

// selectedDetailLine is the idle detail-row text: "<path> · <branch>"
// (branch omitted when empty).
func (ui *worktreeUI) selectedDetailLine() string {
	if ui.selected < 0 || ui.selected >= len(ui.rows) {
		return ""
	}
	r := ui.rows[ui.selected]
	if r.branch == "" {
		return r.path
	}
	if r.path == "" {
		return r.branch
	}
	return r.path + " · " + r.branch
}

// truncateRunes caps s to at most max cells (1 rune ≈ 1 cell; good enough
// for path display). Empty max yields empty string.
func truncateRunes(s string, max int) string {
	if max <= 0 {
		return ""
	}
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	if max == 1 {
		return "…"
	}
	return string(runes[:max-1]) + "…"
}

func (ui *worktreeUI) dispatch(fd int, state *term.State) {
	if ui.selected < 0 || ui.selected >= len(ui.rows) {
		return
	}
	r := ui.rows[ui.selected]

	// Restore termios + cursor BEFORE shelling out to tmux. Mirrors the
	// attention picker's dispatchAttention.
	_ = term.Restore(fd, state)
	_, _ = os.Stdout.WriteString("\x1b[0m\x1b[?25h")

	// `tmux run-shell -b` returns immediately so the popup tears down
	// before tmux-worktree-open.sh starts the (potentially slow) tmux
	// new-window / cd / send-keys round-trip.
	cmd := fmt.Sprintf("bash %s %s %s %s %s",
		shellEscape(ui.openScript),
		shellEscape(ui.sessionName),
		shellEscape(r.path),
		shellEscape(ui.currentWindowID),
		shellEscape(ui.cwd))
	_ = exec.Command("tmux", "run-shell", "-b", cmd).Run()
}

func init() { register(worktreePicker{}) }
