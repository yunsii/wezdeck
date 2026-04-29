// `picker overflow` — TUI for the cross-workspace tab-overflow picker
// (Alt+x). Lists every configured session across every workspace whose
// items snapshot has been written, marked with state (visible/warm/cold)
// and which workspace owns the row. Current workspace's rows rank first
// so the keystroke flow for in-workspace jumps stays unchanged; rows from
// other workspaces sit below and become reachable via the always-on
// substring filter.
//
// Receives a prefetch TSV (built upstream by tab-overflow-menu.sh after
// it scanned `<state>/tab-stats/*-items.json`) so the picker itself
// touches no tab-stats files. The popup lifecycle mirrors the attention
// picker: read TSV → raw mode → first paint → key loop → on Enter, fire
// tab-overflow-dispatch.sh via `tmux run-shell -b` so the popup tears
// down before lua/tmux side-effects start.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

type overflowRow struct {
	workspace   string
	label       string
	cwd         string
	state       string // "visible" | "warm" | "cold"
	hasTab      string // "true" when state=visible, else "false" — fed verbatim to dispatch.sh
	isCurrent   bool
	sessionName string // candidate tmux session name (warm only; informational)
}

type overflowPicker struct{}

func (overflowPicker) Name() string { return "overflow" }

func (overflowPicker) Run(args []string) int {
	if len(args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: picker overflow <prefetch_tsv> <dispatch_sh> [keypress_ts] [menu_start_ts] [menu_done_ts]")
		return 2
	}
	prefetchPath := args[0]
	dispatchScript := args[1]
	ts := parsePerfTimings(args, 2)

	rows, err := loadOverflowRows(prefetchPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "picker: %v\n", err)
		return 1
	}
	if len(rows) == 0 {
		fmt.Fprintln(os.Stderr, "picker: prefetch TSV produced 0 rows")
		return 1
	}

	fd, state, ok := enterRawMode()
	if !ok {
		return 1
	}
	defer restoreRawMode(fd, state)

	// Filter modes:
	//   "all"     — every row (default).
	//   "current" — only rows whose workspace == active workspace.
	// Tab cycles between them. Substring filter on workspace + label +
	// cwd is always-on; runs orthogonally to the workspace mode.
	filterText := ""
	scopeFilter := "all"
	selected := 0

	visible := applyOverflowFilter(rows, filterText, scopeFilter)

	// Workspace column width = max workspace label length, capped so a
	// stray long workspace name doesn't push everything off-screen.
	wsCol := computeWorkspaceColumnWidth(rows, 16)

	render := func() {
		renderOverflowFrame(visible, selected, ts, filterText, scopeFilter, wsCol)
	}
	render()
	ts.emitFirstPaint("overflow.perf", "overflow", "popup paint timing", len(visible), selected, nil)

	cycleScope := func() {
		if scopeFilter == "all" {
			scopeFilter = "current"
		} else {
			scopeFilter = "all"
		}
		selected = 0
		visible = applyOverflowFilter(rows, filterText, scopeFilter)
	}

	return runKeyLoop(func(key string) (loopAction, int) {
		switch key {
		case "\r", "\n":
			if len(visible) == 0 {
				return loopContinue, 0
			}
			dispatchOverflow(visible[selected], dispatchScript)
			return loopExit, 0
		case "\x1bx", "\x03":
			// Forwarded second Alt+x and Ctrl+C — unconditional close.
			// Mirrors attention picker's `\x1b/` handling.
			return loopExit, 0
		case "\x1b":
			// Bare Esc: clear filter when non-empty, otherwise close.
			if filterText != "" {
				filterText = ""
				selected = 0
				visible = applyOverflowFilter(rows, filterText, scopeFilter)
				render()
				return loopContinue, 0
			}
			return loopExit, 0
		case "\x1b[B", "\x1bOB":
			if len(visible) > 0 {
				selected = (selected + 1) % len(visible)
				render()
			}
		case "\x1b[A", "\x1bOA":
			if len(visible) > 0 {
				selected = (selected - 1 + len(visible)) % len(visible)
				render()
			}
		case "\t":
			cycleScope()
			render()
		case "\x7f", "\x08":
			if filterText != "" {
				filterText = filterText[:len(filterText)-1]
				selected = 0
				visible = applyOverflowFilter(rows, filterText, scopeFilter)
				render()
			}
		case "\x15": // Ctrl+U — clear filter.
			if filterText != "" {
				filterText = ""
				selected = 0
				visible = applyOverflowFilter(rows, filterText, scopeFilter)
				render()
			}
		default:
			if len(key) == 1 {
				c := key[0]
				if c >= 0x20 && c <= 0x7E {
					filterText += key
					selected = 0
					visible = applyOverflowFilter(rows, filterText, scopeFilter)
					render()
				}
			}
		}
		return loopContinue, 0
	})
}

func loadOverflowRows(path string) ([]overflowRow, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read prefetch %s: %w", path, err)
	}
	var rows []overflowRow
	for _, line := range strings.Split(strings.TrimRight(string(data), "\n"), "\n") {
		if line == "" {
			continue
		}
		// 7 fields: workspace  label  cwd  state  has_tab  is_current  session_name
		parts := strings.SplitN(line, "\t", 7)
		if len(parts) < 6 {
			continue
		}
		row := overflowRow{
			workspace: parts[0],
			label:     parts[1],
			cwd:       parts[2],
			state:     parts[3],
			hasTab:    parts[4],
			isCurrent: parts[5] == "1",
		}
		if len(parts) >= 7 {
			row.sessionName = parts[6]
		}
		rows = append(rows, row)
	}
	return rows, nil
}

// applyOverflowFilter returns the subset of rows that pass the active
// scope + substring filter. Lowercased substring match runs across
// workspace + label + cwd so the user can disambiguate by typing any
// segment ("cfg neo" hits config/neovim, "video" hits ai-video-collection).
func applyOverflowFilter(rows []overflowRow, filterText, scope string) []overflowRow {
	lower := strings.ToLower(filterText)
	out := make([]overflowRow, 0, len(rows))
	for _, r := range rows {
		if scope == "current" && !r.isCurrent {
			continue
		}
		if filterText != "" {
			haystack := strings.ToLower(r.workspace + " " + r.label + " " + r.cwd)
			if !strings.Contains(haystack, lower) {
				continue
			}
		}
		out = append(out, r)
	}
	return out
}

func computeWorkspaceColumnWidth(rows []overflowRow, cap int) int {
	max := 0
	for _, r := range rows {
		if w := len(r.workspace); w > max {
			max = w
		}
	}
	if max > cap {
		max = cap
	}
	if max < 4 {
		max = 4
	}
	return max
}

func renderOverflowFrame(rows []overflowRow, selected int, ts perfTimings, filterText, scope string, wsCol int) {
	_, lines := getTermSize()
	visibleRows := lines - 5
	if visibleRows < 1 {
		visibleRows = 1
	}
	itemCount := len(rows)

	startIndex := 0
	if selected >= visibleRows {
		startIndex = selected - visibleRows + 1
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

	var b strings.Builder
	b.Grow(2048)

	titleN := selected + 1
	if itemCount == 0 {
		titleN = 0
	}
	b.WriteString("\x1b[1;1H\x1b[1m")
	fmt.Fprintf(&b, "Sessions across workspaces — %d/%d", titleN, itemCount)
	b.WriteString(reset)
	if scope == "current" {
		b.WriteString("  \x1b[1;38;5;39m[current workspace]")
		b.WriteString(reset)
	} else {
		b.WriteString("  \x1b[2m·  Tab limits to current workspace")
		b.WriteString(reset)
	}
	b.WriteString(clearEOL)

	cursor := "\x1b[7m \x1b[27m"
	if filterText != "" {
		fmt.Fprintf(&b, "\x1b[2;1HSearch: %s%s", filterText, cursor)
	} else {
		fmt.Fprintf(&b, "\x1b[2;1H\x1b[2mSearch: %s\x1b[2m Type to filter (Tab toggles scope)…%s", cursor, reset)
	}
	b.WriteString(clearEOL)

	row := 4
	if itemCount == 0 {
		fmt.Fprintf(&b, "\x1b[%d;1H\x1b[2mNo matches — Esc clears search, Tab toggles scope, Backspace edits.%s%s", row, reset, clearEOL)
		row++
	}
	for i := startIndex; i <= endIndex; i++ {
		fmt.Fprintf(&b, "\x1b[%d;1H", row)
		r := rows[i]
		if i == selected {
			b.WriteString("▶ ")
		} else {
			b.WriteString("  ")
		}
		b.WriteString(overflowStateIcon(r.state))
		b.WriteString("  ")
		b.WriteString(formatWorkspaceCell(r.workspace, wsCol, r.isCurrent))
		b.WriteString("  ")
		b.WriteString(r.label)
		if r.cwd != "" {
			fmt.Fprintf(&b, "  \x1b[2m%s%s", r.cwd, reset)
		}
		b.WriteString(clearEOL)
		row++
	}

	fmt.Fprintf(&b, "\x1b[%d;1H%s", row, clearEOL)
	row++
	fmt.Fprintf(&b, "\x1b[%d;1H", row)
	b.WriteString("\x1b[2mEnter open | Up/Down move | type filter | Tab scope | Esc clear/close  ·  powered by ")
	b.WriteString("\x1b[22;1;38;5;108mgo")
	b.WriteString(reset)
	ts.renderFooterTail(&b)
	b.WriteString(clearEOL)
	b.WriteString("\x1b[J")

	_, _ = os.Stdout.WriteString(b.String())
}

func overflowStateIcon(state string) string {
	// Same shape (3-cell) for every state so the workspace column lines
	// up regardless of which marker the row carries.
	switch state {
	case "visible":
		return "\x1b[1;38;5;39m●\x1b[0m  "
	case "warm":
		return "\x1b[38;5;208m◐\x1b[0m  "
	case "cold":
		return "\x1b[2;38;5;245m○\x1b[0m  "
	}
	return "·  "
}

func formatWorkspaceCell(name string, width int, current bool) string {
	display := name
	if len(display) > width {
		display = display[:width]
	}
	pad := width - len(display)
	padding := ""
	if pad > 0 {
		padding = strings.Repeat(" ", pad)
	}
	if current {
		return "\x1b[1;38;5;108m" + display + "\x1b[0m" + padding
	}
	return "\x1b[38;5;245m" + display + "\x1b[0m" + padding
}

func dispatchOverflow(r overflowRow, dispatchScript string) {
	_, _ = os.Stdout.WriteString("\x1b[0m\x1b[?25h")

	emitPerfEvent("overflow", "overflow dispatch", map[string]string{
		"workspace": r.workspace,
		"cwd":       r.cwd,
		"state":     r.state,
		"current":   boolToStr(r.isCurrent),
	})

	cmd := fmt.Sprintf("bash %s %s %s %s",
		shellEscape(dispatchScript),
		shellEscape(r.workspace),
		shellEscape(r.cwd),
		shellEscape(r.hasTab))
	_ = exec.Command("tmux", "run-shell", "-b", cmd).Run()
}

func boolToStr(v bool) string {
	if v {
		return "1"
	}
	return "0"
}

func init() { register(overflowPicker{}) }
