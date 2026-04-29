// `picker attention` — TUI for the agent-attention overlay (Alt+/).
//
// Receives a prefetch TSV (built upstream by the WezTerm Lua handler /
// tmux-attention-menu.sh) so the picker itself never touches state.json
// or jq. The popup lifecycle is: read TSV → raw mode → first paint →
// key loop → on Enter, fire attention-jump.sh via `tmux run-shell -b`
// (popup tears down before the jump round-trip starts).
package main

import (
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

type attentionRow struct {
	status      string // "running" | "waiting" | "done" | "recent" | "__sentinel__"
	body        string
	age         string
	id          string
	lastStatus  string // for "recent" rows: "running" | "waiting" | "done"; empty otherwise
	weztermPane string
	tmuxSocket  string
	tmuxWindow  string
	tmuxPane    string
	tmuxSession string // 10th TSV col: name from attention.json. Carried so
	// payload generation can append it without round-tripping through
	// `tmux display-message` (which fails for archived rows whose
	// stored window id is no longer valid).
	workspace string // canonical workspace name — set from body parts[0]
	// (lua-derived) by splitAttentionBodies, with the tmux_session
	// regex (`wezterm_<ws>_...`) as a fallback. Empty for the sentinel
	// row and for sessions whose name doesn't match either source.
	isCurrent  bool  // workspace == active workspace at popup launch.
	ageSeconds int64 // `age` text parsed back to seconds (Ns / Nm / Nh).
	// Drives the secondary sort key after status priority — smaller =
	// more recent. Missing / unparseable age becomes 0 (treated as
	// most recent), which is the right behavior for active rows that
	// don't render an age (`running` "right now").
	// Body sub-fields, populated by splitAttentionBodies. The lua-side
	// `compute_label` joins them as `<workspace>/<tab>/<tmux_seg>/<branch>`
	// and the `compute_picker_data` glue appends `  <reason>`. We re-
	// split here so the renderer can column-align them.
	tab       string // e.g. "1_wezterm-config"
	tmuxSeg   string // e.g. "1_2"
	branch    string // git branch (may contain '/')
	reason    string // status reason (e.g. "task done", "running"); the
	// emoji column already encodes the status itself.
	rawBody string // original body kept around for the sentinel and the
	// fallback path when split fails (unknown shape).
}

type attentionPicker struct{}

func (attentionPicker) Name() string { return "attention" }

func (attentionPicker) Run(args []string) int {
	if len(args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: picker attention <prefetch_tsv> <attention_jump_sh> [current_workspace] [keypress_ts] [menu_start_ts] [menu_done_ts]")
		return 2
	}
	prefetchPath := args[0]
	jumpScript := args[1]
	// Optional positional: active workspace name (resolved by menu.sh
	// from `tmux show-options @wezterm_workspace`). Drives current-first
	// row partitioning + the workspace-column highlight. Empty / "" is
	// tolerated — the picker degrades to a single-tier list with all
	// rows tagged non-current, matching pre-workspace-aware behavior.
	currentWorkspace := ""
	if len(args) >= 3 {
		currentWorkspace = args[2]
	}
	// Optional diagnostic timestamps (all epoch ms, 0 disables that
	// segment). The footer breaks elapsed into three buckets so the user
	// can see WHERE the cold-start cost lives:
	//   L = menu_start - keypress  (lua handler + tmux dispatch + bash boot)
	//   M = menu_done  - menu_start (menu.sh work: jq + popup spawn)
	//   P = render     - menu_done  (popup pty + go runtime + first frame)
	ts := parsePerfTimings(args, 3)

	rows, err := loadAttentionRows(prefetchPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "picker: %v\n", err)
		return 1
	}
	if len(rows) == 0 {
		fmt.Fprintln(os.Stderr, "picker: prefetch TSV produced 0 rows")
		return 1
	}

	// Tag each row with its workspace + is-current flag, then re-rank so
	// active-workspace rows come first within each status block. The
	// Lua-side compute_picker_data already orders rows by status
	// priority (waiting → done → running, with recent + sentinel
	// trailing); rankAttentionByWorkspace preserves that ordering as
	// the secondary key so the picker still leads with the most-
	// urgent row, but pulled-up to the current workspace tier.
	// Split body so each row's lua-encoded
	// `<ws>/<tab>/<tmux_seg>/<branch>  <reason>` becomes individual
	// columns; parts[0] is also the canonical workspace value (more
	// reliable than the regex on tmux_session when the entry has no
	// session or the name doesn't match `wezterm_<ws>_...`).
	splitAttentionBodies(rows)
	// Fill workspace + isCurrent + ageSeconds for filter/render/sort.
	populateAttentionRowFields(rows, currentWorkspace)
	// Sort: status priority (waiting → done → running → recent →
	// sentinel) primary, most-recent activity secondary. The lua
	// side already groups by status but the within-status order is
	// driven by entry insertion shape (entries[] order then recent
	// dedupe), which doesn't always lead with the freshest event.
	// Age — already projected into ageSeconds by
	// populateAttentionRowFields — gives "freshest first" within
	// each block; smaller seconds = more recent.
	sort.SliceStable(rows, func(i, j int) bool {
		pi, pj := attentionStatusPriority(rows[i].status), attentionStatusPriority(rows[j].status)
		if pi != pj {
			return pi < pj
		}
		return rows[i].ageSeconds < rows[j].ageSeconds
	})
	colWidths := computeAttentionColumnWidths(rows)

	fd, state, ok := enterRawMode()
	if !ok {
		return 1
	}
	defer restoreRawMode(fd, state)

	// Type-to-filter is always-on (mirrors the command palette); there is
	// no separate "filter mode" to enter. Every printable keystroke goes
	// straight into the substring filter, the search row at line 2 is
	// always visible, and Tab still cycles the orthogonal status filter.
	filterText := ""
	statusFilter := "all" // "all" | "running" | "waiting" | "done"
	selected := 0

	visible := applyAttentionFilter(rows, filterText, statusFilter)

	render := func() {
		renderAttentionFrame(visible, selected, ts, filterText, statusFilter, colWidths, currentWorkspace)
	}
	render()
	// Once-per-popup perf event, dispatched AFTER the first frame's bytes
	// hit stdout — see docs/logging-conventions.md "Render-path discipline".
	ts.emitFirstPaint("attention.perf", "attention", "popup paint timing", len(visible), selected, nil)

	cycleStatus := func() {
		switch statusFilter {
		case "all":
			statusFilter = "waiting"
		case "waiting":
			statusFilter = "done"
		case "done":
			statusFilter = "running"
		case "running":
			statusFilter = "all"
		default:
			statusFilter = "all"
		}
		selected = 0
		visible = applyAttentionFilter(rows, filterText, statusFilter)
	}

	return runKeyLoop(func(key string) (loopAction, int) {
		switch key {
		case "\r", "\n":
			if len(visible) == 0 {
				return loopContinue, 0
			}
			dispatchAttention(visible[selected], jumpScript)
			return loopExit, 0
		case "\x1b/", "\x03":
			// Forwarded second Alt+/ and Ctrl+C — unconditional close.
			// Preserves toggle behaviour and gives the user a stable
			// escape hatch even when the filter is non-empty.
			return loopExit, 0
		case "\x1b":
			// Bare Esc: clear filter when non-empty, otherwise close.
			// Matches the command palette's Esc semantics so the user
			// can back out of a search without losing the popup.
			if filterText != "" {
				filterText = ""
				selected = 0
				visible = applyAttentionFilter(rows, filterText, statusFilter)
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
			cycleStatus()
			render()
		case "\x7f", "\x08":
			if filterText != "" {
				filterText = filterText[:len(filterText)-1]
				selected = 0
				visible = applyAttentionFilter(rows, filterText, statusFilter)
				render()
			}
		case "\x15": // Ctrl+U — clear filter in one keystroke.
			if filterText != "" {
				filterText = ""
				selected = 0
				visible = applyAttentionFilter(rows, filterText, statusFilter)
				render()
			}
		default:
			// Append printable ASCII only (single byte 0x20–0x7E). Stray
			// escape sequences or multi-byte input is ignored so it
			// cannot pollute the filter string.
			if len(key) == 1 {
				c := key[0]
				if c >= 0x20 && c <= 0x7E {
					filterText += key
					selected = 0
					visible = applyAttentionFilter(rows, filterText, statusFilter)
					render()
				}
			}
		}
		return loopContinue, 0
	})
}

// applyAttentionFilter returns the subset of rows that pass the current
// filter. The clear-all sentinel is included only when both filter
// dimensions are at their defaults (empty text + "all" status) — the
// sentinel is a meta action and the user typing/cycling clearly excludes
// it from intent.
//
// Substring filter matches lowercased `<workspace>  <body>` so typing
// the workspace name scopes the picker to that workspace alone — the
// row-level workspace badge is just a visual aid; the source of truth
// is the haystack here.
func applyAttentionFilter(rows []attentionRow, filterText, statusFilter string) []attentionRow {
	filterActive := filterText != "" || statusFilter != "all"
	lowerFilter := strings.ToLower(filterText)
	out := make([]attentionRow, 0, len(rows))
	for _, r := range rows {
		if r.status == "__sentinel__" {
			if filterActive {
				continue
			}
			out = append(out, r)
			continue
		}
		if statusFilter != "all" && r.status != statusFilter {
			continue
		}
		if filterText != "" {
			haystack := strings.ToLower(r.workspace + " " + r.body)
			if !strings.Contains(haystack, lowerFilter) {
				continue
			}
		}
		out = append(out, r)
	}
	return out
}

// populateAttentionRowFields fills in workspace + isCurrent on each
// row so the renderer / filter can read them. No sort — Alt+/ orders
// by status priority (waiting → done → running, recent trailing,
// sentinel last), the order `attention.lua/compute_picker_data`
// already produces; reshuffling by workspace tier here would split
// the urgent-waiting rows the badge in the status bar advertises.
// Cross-workspace info still surfaces through the workspace column
// + the substring filter (typing the workspace name scopes the list
// to that workspace alone).
//
// Workspace value precedence: body's parts[0] (lua-derived,
// populated by splitAttentionBodies before this call) → regex on
// tmuxSession as a fallback.
var sessionWorkspacePattern = regexp.MustCompile(`^wezterm_([^_]+)_`)

func populateAttentionRowFields(rows []attentionRow, currentWorkspace string) {
	for i := range rows {
		if rows[i].status == "__sentinel__" {
			rows[i].workspace = ""
			rows[i].isCurrent = false
			rows[i].ageSeconds = 1<<62 - 1 // pin sentinel to the bottom
			// regardless of the secondary key — the primary key
			// (status priority) puts it last anyway, but a maxed
			// ageSeconds keeps the comparator monotonic in case the
			// priority table is ever extended.
			continue
		}
		if rows[i].workspace == "" {
			rows[i].workspace = extractWorkspaceFromSession(rows[i].tmuxSession)
		}
		rows[i].isCurrent = currentWorkspace != "" && rows[i].workspace == currentWorkspace
		rows[i].ageSeconds = parseAgeToSeconds(rows[i].age)
	}
}

// attentionStatusPriority — sort tier for the picker. Mirrors the
// status-bar badge ordering: waiting (needs response) → done (FYI) →
// running (informational) → recent (archived) → sentinel (clear-all).
// Anything outside the known set sorts last so unexpected statuses
// don't accidentally shadow the live work.
func attentionStatusPriority(status string) int {
	switch status {
	case "waiting":
		return 0
	case "done":
		return 1
	case "running":
		return 2
	case "recent":
		return 3
	case "__sentinel__":
		return 4
	}
	return 5
}

// parseAgeToSeconds reverse-projects the lua-side `format_age` output
// (`Ns` / `Nm` / `Nh`) back to seconds so we can use it as a sort key.
// Empty / unparseable values return 0, which the comparator treats as
// "most recent" — correct for live rows that lua deliberately renders
// without an age (e.g. running "right now").
func parseAgeToSeconds(age string) int64 {
	if len(age) < 2 {
		return 0
	}
	suffix := age[len(age)-1]
	num, err := strconv.ParseInt(age[:len(age)-1], 10, 64)
	if err != nil || num < 0 {
		return 0
	}
	switch suffix {
	case 's':
		return num
	case 'm':
		return num * 60
	case 'h':
		return num * 3600
	}
	return 0
}

func extractWorkspaceFromSession(session string) string {
	if session == "" {
		return ""
	}
	m := sessionWorkspacePattern.FindStringSubmatch(session)
	if len(m) < 2 {
		return ""
	}
	return m[1]
}

// attentionColWidths captures the per-column width budget the renderer
// uses to align rows. Width is the visible cell count, not byte length;
// every field is ASCII-ish in practice (tab segment / tmux_seg / branch
// / workspace) so byte length is a fine proxy. Each width is capped to
// keep one ridiculously long branch name from blowing out the layout.
type attentionColWidths struct {
	workspace int
	tab       int
	tmuxSeg   int
	branch    int
}

func computeAttentionColumnWidths(rows []attentionRow) attentionColWidths {
	w := attentionColWidths{}
	for _, r := range rows {
		if r.status == "__sentinel__" {
			continue
		}
		if l := len(r.workspace); l > w.workspace {
			w.workspace = l
		}
		if l := len(r.tab); l > w.tab {
			w.tab = l
		}
		if l := len(r.tmuxSeg); l > w.tmuxSeg {
			w.tmuxSeg = l
		}
		if l := len(r.branch); l > w.branch {
			w.branch = l
		}
	}
	w.workspace = clampColumnWidth(w.workspace, 4, 12)
	w.tab = clampColumnWidth(w.tab, 0, 22)
	w.tmuxSeg = clampColumnWidth(w.tmuxSeg, 0, 8)
	w.branch = clampColumnWidth(w.branch, 0, 18)
	return w
}

func clampColumnWidth(v, lo, hi int) int {
	if v == 0 && lo == 0 {
		return 0
	}
	if v < lo {
		v = lo
	}
	if v > hi {
		v = hi
	}
	return v
}

// splitAttentionBodies parses the lua-encoded body shape
// `<workspace>/<tab>/<tmux_seg>/<branch>  <reason>` (joined by `/`,
// then ` 2sp ` separator) into the four sub-fields the renderer
// column-aligns. Branch can itself contain `/` (e.g. `task/dev-infra`),
// which is why we use SplitN with N=4 and treat the trailing slice as
// branch+reason. When the body doesn't match the expected shape (very
// short, missing slashes), all sub-fields stay empty and the renderer
// falls back to printing rawBody as the only content.
func splitAttentionBodies(rows []attentionRow) {
	for i := range rows {
		rows[i].rawBody = rows[i].body
		if rows[i].status == "__sentinel__" {
			continue
		}
		// `body` shape: ws/tab/tmux_seg/branch[  reason] — ignore
		// rows that don't have the four leading slash-delimited
		// segments.
		parts := strings.SplitN(rows[i].body, "/", 4)
		if len(parts) < 4 {
			continue
		}
		// parts[0] is the lua-derived workspace name (host_info.workspace
		// with the session-prefix fallback). Take it as the canonical
		// workspace — more reliable than the regex on tmux_session,
		// which goes empty when the entry has no tmux_session or its
		// name doesn't match the managed shape. Skip the assignment
		// only when parts[0] is the literal `?` placeholder
		// `compute_label` emits when every fallback failed.
		if parts[0] != "" && parts[0] != "?" {
			rows[i].workspace = parts[0]
		}
		rows[i].tab = parts[1]
		rows[i].tmuxSeg = parts[2]
		rest := parts[3]
		if idx := strings.Index(rest, "  "); idx >= 0 {
			rows[i].branch = rest[:idx]
			rows[i].reason = strings.TrimLeft(rest[idx:], " ")
		} else {
			rows[i].branch = rest
		}
	}
}

func loadAttentionRows(path string) ([]attentionRow, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read prefetch %s: %w", path, err)
	}
	var rows []attentionRow
	for _, line := range strings.Split(strings.TrimRight(string(data), "\n"), "\n") {
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 9)
		if len(parts) < 4 {
			continue
		}
		row := attentionRow{
			status: parts[0],
			body:   parts[1],
			age:    parts[2],
			id:     parts[3],
		}
		// TSV column order matches tmux-attention-menu.sh:
		//   parts[4] = wezterm_pane_id
		//   parts[5] = tmux_socket
		//   parts[6] = tmux_window
		//   parts[7] = tmux_pane
		//   parts[8] = last_status
		//   parts[9] = tmux_session
		// last_status sits at idx 8 (not last) only because of historical
		// ordering — both it and the trailing tmux_session may be empty
		// for active rows / sentinel without confusing bash `read -r` so
		// long as nothing in between is also empty.
		if len(parts) >= 5 {
			row.weztermPane = parts[4]
		}
		if len(parts) >= 6 {
			row.tmuxSocket = parts[5]
		}
		if len(parts) >= 7 {
			row.tmuxWindow = parts[6]
		}
		if len(parts) >= 8 {
			row.tmuxPane = parts[7]
		}
		if len(parts) >= 9 {
			row.lastStatus = parts[8]
		}
		if len(parts) >= 10 {
			row.tmuxSession = parts[9]
		}
		rows = append(rows, row)
	}
	return rows, nil
}

// renderAttentionFrame mirrors scripts/runtime/tmux-attention/render.sh's
// `attention_picker_emit_frame` byte-for-byte: same ANSI positioning,
// same color codes, same selection highlight scheme. If you change
// either, change both — the bash menu.sh side still pre-renders the
// first frame for the bash fallback path. Layout updated to match the
// Alt+x overflow picker: a workspace badge column sits between the
// status badge and the body, current-workspace rows are highlighted in
// the same color family, and rows are pre-ranked so the active
// workspace's entries appear first.
func renderAttentionFrame(rows []attentionRow, selected int, ts perfTimings, filterText, statusFilter string, cols attentionColWidths, currentWorkspace string) {
	_, lines := getTermSize()
	// 5 non-row lines: title, search input, blank divider, blank-before-
	// footer, footer.
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

	// Title row. The substring filter has its own search row below; the
	// title only shows count + (when active) the status filter chip.
	titleN := selected + 1
	if itemCount == 0 {
		titleN = 0
	}
	b.WriteString("\x1b[1;1H\x1b[1m")
	fmt.Fprintf(&b, "Agent attention — %d/%d", titleN, itemCount)
	if currentWorkspace != "" {
		fmt.Fprintf(&b, "  ·  active workspace \x1b[1;38;5;108m%s\x1b[0m\x1b[1m", currentWorkspace)
	}
	if statusFilter == "all" {
		b.WriteString("  ·  order matches status bar (🚨 → ✅ → 🔄)")
		b.WriteString(reset)
	} else {
		b.WriteString(reset)
		switch statusFilter {
		case "running":
			b.WriteString("  \x1b[1;38;5;39m[🔄 running]")
			b.WriteString(reset)
		case "waiting":
			b.WriteString("  \x1b[1;38;5;208m[🚨 waiting]")
			b.WriteString(reset)
		case "done":
			b.WriteString("  \x1b[38;5;108m[✅ done]")
			b.WriteString(reset)
		}
	}
	b.WriteString(clearEOL)

	// Search row at line 2 — always visible (command-palette style). Empty
	// state shows a dim placeholder so the affordance is discoverable.
	cursor := "\x1b[7m \x1b[27m"
	if filterText != "" {
		fmt.Fprintf(&b, "\x1b[2;1HSearch: %s%s", filterText, cursor)
	} else {
		fmt.Fprintf(&b, "\x1b[2;1H\x1b[2mSearch: %s\x1b[2m Type to filter (Tab cycles status)…%s", cursor, reset)
	}
	b.WriteString(clearEOL)

	// Item rows start at row 4 (row 1 = title, row 2 = search, row 3 =
	// blank divider).
	row := 4
	if itemCount == 0 {
		fmt.Fprintf(&b, "\x1b[%d;1H\x1b[2mNo matches — Esc clears search, Tab cycles status, Backspace edits.%s%s", row, reset, clearEOL)
		row++
	}
	for i := startIndex; i <= endIndex; i++ {
		fmt.Fprintf(&b, "\x1b[%d;1H", row)
		r := rows[i]
		// Only the leading caret distinguishes selected from unselected;
		// everything else (badge color, body, dim age) renders identically.
		// The 2-col gutter is reserved on every row so column alignment
		// stays stable as the cursor moves.
		if i == selected {
			b.WriteString("▶ ")
		} else {
			b.WriteString("  ")
		}
		b.WriteString(coloredBadge(r.status))
		// Three-space gap between aligned columns. Padded columns
		// (workspace, repo/tab) are followed by `gap`; everything
		// from the branch onward is variable-width and joined by
		// the same 3-space separator without any padding so reasons
		// and ages don't drag a long blank channel behind a short
		// branch name.
		const gap = "   "
		b.WriteString(gap)
		if r.status == "__sentinel__" {
			// Meta row — no per-field columns. Fall through to the
			// raw sentinel body and skip the per-column padding.
			b.WriteString(r.rawBody)
			b.WriteString(clearEOL)
			row++
			continue
		}
		// Workspace badge column: same shape as Alt+x — bright color
		// family for the active workspace, dim for others, empty
		// padding when the workspace couldn't be parsed.
		b.WriteString(formatAttentionWorkspaceCell(r.workspace, cols.workspace, r.isCurrent))
		b.WriteString(gap)
		// Repo / tab segment (e.g. `1_wezterm-config`). Padded to
		// cols.tab so the next column lands at the same screen column
		// across rows. This is the last padded column.
		b.WriteString(padCell(r.tab, cols.tab))
		b.WriteString(gap)
		// Branch + pane id, then reason, then age — all variable
		// width, joined by `gap` only. No padding past this point so
		// short branches don't trail a wide empty space before the
		// reason text.
		bp := formatAttentionBranchPane(r.branch, r.tmuxSeg)
		if bp != "" {
			b.WriteString(bp)
		}
		if r.reason != "" {
			if bp != "" {
				b.WriteString(gap)
			}
			b.WriteString(r.reason)
		}
		if r.age != "" {
			b.WriteString(gap)
			b.WriteString("\x1b[2m(")
			b.WriteString(r.age)
			b.WriteString(")")
			b.WriteString(reset)
		}
		// Recent rows carry the prior live status as a dim suffix so the
		// user can tell at a glance what the entry was doing when it was
		// archived (e.g. an unfinished waiting prompt vs a clean done).
		if r.status == "recent" && r.lastStatus != "" {
			fmt.Fprintf(&b, "%s\x1b[2m(%s, archived)%s", gap, r.lastStatus, reset)
		}
		b.WriteString(clearEOL)
		row++
	}

	// Footer: blank divider then dim hint + powered-by badge + (when a
	// keypress ts is provided) end-to-end key→paint latency. The
	// powered-by badge makes which code path is live legible at a glance
	// during the parallel-implementation phase (this Go binary vs the
	// bash fallback); same green family as `✓ DONE` (palette 108)
	// signals "fast path active". The latency badge is the diagnostic
	// readout the user is actively comparing across runs — drop both
	// once the bash picker is removed.
	//
	// The blank divider row must be explicitly cleared: when a previous
	// frame had a smaller item count its footer landed where this frame's
	// divider lives, and the trailing `\x1b[J` only wipes lines BELOW the
	// new footer. Without this `\x1b[K` the old footer ghosts through.
	fmt.Fprintf(&b, "\x1b[%d;1H%s", row, clearEOL)
	row++
	fmt.Fprintf(&b, "\x1b[%d;1H", row)
	b.WriteString("\x1b[2mEnter jump | Up/Down move | type filter | Tab status | Esc clear/close  ·  powered by ")
	b.WriteString("\x1b[22;1;38;5;108mgo")
	b.WriteString(reset)
	ts.renderFooterTail(&b)
	b.WriteString(clearEOL)

	// Wipe anything still drawn below the footer (e.g. stale content from
	// a taller previous frame in the same popup pty).
	b.WriteString("\x1b[J")

	_, _ = os.Stdout.WriteString(b.String())
}

// padCell pads `s` with trailing spaces up to `width`. Truncates from
// the right when `s` is longer than `width`. Width=0 returns the empty
// string so optional columns disappear cleanly when no row populates
// them. Plain text only — no ANSI; callers wrap before/after when
// they need color.
func padCell(s string, width int) string {
	if width <= 0 {
		return ""
	}
	if len(s) >= width {
		if len(s) == width {
			return s
		}
		return s[:width]
	}
	return s + strings.Repeat(" ", width-len(s))
}

// formatAttentionBranchPane joins `branch` + `tmux_seg` (e.g.
// `master · 1_2`) with a dim middle-dot separator and dims the pane
// id so the branch reads as the primary identifier. Variable width:
// the caller pastes a fixed gap *after* this segment instead of
// padding it, so short branches don't trail a wide empty channel.
// When either field is empty the separator is dropped; both empty
// returns "".
func formatAttentionBranchPane(branch, tmuxSeg string) string {
	const reset = "\x1b[0m"
	const dim = "\x1b[2m"
	switch {
	case branch != "" && tmuxSeg != "":
		return branch + dim + " · " + tmuxSeg + reset
	case branch != "":
		return branch
	case tmuxSeg != "":
		return dim + tmuxSeg + reset
	}
	return ""
}

// formatAttentionWorkspaceCell — workspace badge column formatter.
// Same width/coloring contract as the Alt+x overflow picker so the
// two pickers feel like one family. Truncates at `width` instead of
// padding into the next row when the workspace name overflows; the
// fuzzy filter still matches the full untruncated name. Empty
// workspace (session name didn't match the managed-session shape, or
// tmux_session was missing from the TSV) renders as blank padding —
// no `·` placeholder, since the body already carries the workspace
// prefix and a column of dots reads as visual noise.
func formatAttentionWorkspaceCell(name string, width int, current bool) string {
	if width <= 0 {
		return ""
	}
	display := name
	if len(display) > width {
		display = display[:width]
	}
	pad := width - len(display)
	padding := ""
	if pad > 0 {
		padding = strings.Repeat(" ", pad)
	}
	if display == "" {
		return padding
	}
	if current {
		return "\x1b[1;38;5;108m" + display + "\x1b[0m" + padding
	}
	return "\x1b[38;5;245m" + display + "\x1b[0m" + padding
}

func coloredBadge(status string) string {
	// Emoji-only badge — text labels (RUN/WAIT/DONE/RCNT/CLR) used to
	// trail every emoji to give the user a fallback when emoji
	// presentation glyphs went missing, but in practice the popup
	// lives inside a wezterm pty where emoji rendering is reliable
	// and the labels were just visual noise. All glyphs land at 2
	// cells; the row layout adds a fixed 4-space gap downstream so
	// the body column stays aligned regardless of status.
	switch status {
	case "running":
		return "\x1b[1;38;5;39m🔄\x1b[0m"
	case "waiting":
		return "\x1b[1;38;5;208m🚨\x1b[0m"
	case "done":
		return "\x1b[38;5;108m✅\x1b[0m"
	case "recent":
		return "\x1b[2;38;5;245m📜\x1b[0m"
	case "__sentinel__":
		return "\x1b[1;38;5;160m❌\x1b[0m"
	}
	return "· "
}

func dispatchAttention(r attentionRow, jumpScript string) {
	// Restore termios + show cursor BEFORE the dispatch side-effect so the
	// popup pty cleans up cleanly even if anything below has any observable
	// effect on the parent fd state.
	_, _ = os.Stdout.WriteString("\x1b[0m\x1b[?25h")

	if r.id == "__clear_all__" {
		// clear-all has no GUI focus to perform — keep the legacy
		// `tmux run-shell -b bash ... --clear-all` dispatch.
		emitPerfEvent("attention", "alt-slash clear-all", map[string]string{
			"row_status": r.status, "row_id": r.id,
		})
		cmd := fmt.Sprintf("bash %s --clear-all", shellEscape(jumpScript))
		_ = exec.Command("tmux", "run-shell", "-b", cmd).Run()
		return
	}

	// Active and recent jumps go via OSC 1337 SetUserVar=attention_jump=<payload>.
	// titles.lua's user-var-changed handler in WezTerm receives the payload,
	// performs the in-process mux activate (same path Alt+,/. use), and
	// spawns `attention-jump.sh --direct` for the tmux side. This keeps the
	// hot path off `wezterm.exe cli activate-pane`, which can't reliably
	// reach the running gui process from a popup pty across the WSL boundary
	// (gui-sock-* discovery sometimes picks a stale pid).
	payload := buildAttentionJumpPayload(r)
	if payload == "" {
		emitPerfEvent("attention", "alt-slash dispatch missing coords, fallback --session", map[string]string{
			"row_status":   r.status,
			"row_id":       r.id,
			"wezterm_pane": r.weztermPane,
			"tmux_socket":  r.tmuxSocket,
			"tmux_window":  r.tmuxWindow,
			"tmux_pane":    r.tmuxPane,
		})
		cmd := fmt.Sprintf("bash %s --session %s", shellEscape(jumpScript), shellEscape(r.id))
		_ = exec.Command("tmux", "run-shell", "-b", cmd).Run()
		return
	}
	emitPerfEvent("attention", "alt-slash dispatch", map[string]string{
		"row_status":   r.status,
		"row_id":       r.id,
		"payload_len":  fmt.Sprintf("%d", len(payload)),
		"wezterm_pane": r.weztermPane,
		"tmux_socket":  r.tmuxSocket,
		"tmux_window":  r.tmuxWindow,
		"tmux_pane":    r.tmuxPane,
	})
	if !sendAttentionJump(payload) {
		// Bus delivery failed (read-only state dir, missing event dir
		// env, etc.) — fall back to the legacy --session dispatch so
		// the user still gets some attempt at a jump.
		cmd := fmt.Sprintf("bash %s --session %s", shellEscape(jumpScript), shellEscape(r.id))
		_ = exec.Command("tmux", "run-shell", "-b", cmd).Run()
	}
}

// buildAttentionJumpPayload assembles the v1|... payload for the OSC user
// var. Returns "" when the row lacks coordinates the Lua handler needs.
// For recent rows the picker re-resolves the WezTerm pane id from the
// target tmux session env (`tmux show-environment WEZTERM_PANE`) before
// committing to the payload, since the stored value is whatever was live
// at archive time and WezTerm restarts give it a fresh id while tmux
// survives.
func buildAttentionJumpPayload(r attentionRow) string {
	if r.tmuxSocket == "" || r.tmuxWindow == "" {
		return ""
	}
	// Resolve the target tmux session name once. Both branches append
	// it to the payload so the wezterm-side activate_in_gui can fall
	// back via the unified pane→session map (covers the cap-eviction /
	// workspace-reopen / overflow-rotation cases where the stored
	// wezterm_pane_id is stale). Carried-from-TSV value (from
	// attention.json entries[]/recent[]) is authoritative and survives
	// archived rows whose stored window id no longer exists; runtime
	// `tmux display-message` resolution is the fallback.
	sessName := r.tmuxSession
	if sessName == "" {
		sessName = sessionNameFromCoords(r)
	}
	if strings.HasPrefix(r.id, "recent::") {
		rest := strings.TrimPrefix(r.id, "recent::")
		sid, archived, _ := strings.Cut(rest, "::")
		if sid == "" {
			return ""
		}
		wp := r.weztermPane
		if live := lookupLiveWezTermPane(r.tmuxSocket, sessName); live != "" {
			wp = live
		}
		return fmt.Sprintf("v1|recent|%s|%s|%s|%s|%s|%s|%s",
			sid, archived, wp, r.tmuxSocket, r.tmuxWindow, r.tmuxPane, sessName)
	}
	return fmt.Sprintf("v1|jump|%s|%s|%s|%s|%s|%s",
		r.id, r.weztermPane, r.tmuxSocket, r.tmuxWindow, r.tmuxPane, sessName)
}

// sessionNameFromCoords resolves the tmux session NAME for the row's
// coordinates by asking `tmux -S <socket> display-message` keyed off the
// window id. The prefetch TSV carries socket / window / pane but not
// session_name, and `tmux show-environment` needs the name (`-t @5` is
// not a valid target for show-environment).
func sessionNameFromCoords(r attentionRow) string {
	if r.tmuxSocket == "" || r.tmuxWindow == "" {
		return ""
	}
	out, err := exec.Command("tmux", "-S", r.tmuxSocket,
		"display-message", "-p", "-t", r.tmuxWindow, "#S").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func lookupLiveWezTermPane(socket, session string) string {
	if socket == "" || session == "" {
		return ""
	}
	out, err := exec.Command("tmux", "-S", socket,
		"show-environment", "-t", session, "WEZTERM_PANE").Output()
	if err != nil {
		return ""
	}
	line := strings.TrimSpace(string(out))
	if !strings.HasPrefix(line, "WEZTERM_PANE=") {
		return ""
	}
	return strings.TrimPrefix(line, "WEZTERM_PANE=")
}

// sendAttentionJump publishes the picker's jump intent through the
// unified event bus (see wezbus.go and docs/event-bus.md). Picker is
// always invoked from inside a `tmux display-popup -E` sub-pty, where
// the OSC route would silently drop, so the bus's transport selection
// (with WEZTERM_EVENT_FORCE_FILE=1 injected by tmux-attention-menu.sh)
// reliably picks the file branch. The transport is logged so the
// runtime trail shows which branch ran without us having to know it
// here.
func sendAttentionJump(payload string) bool {
	transport, err := wezbusSend("attention.jump", payload)
	if err != nil {
		emitPerfEvent("attention", "event-bus send failed", map[string]string{
			"event":     "attention.jump",
			"transport": transport,
			"err":       err.Error(),
		})
		return false
	}
	emitPerfEvent("attention", "event-bus dispatched", map[string]string{
		"event":     "attention.jump",
		"transport": transport,
	})
	return true
}

func init() { register(attentionPicker{}) }
