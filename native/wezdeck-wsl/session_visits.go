package main

// When you last visited a worktree, from the access ledger that Alt+g / Alt+x
// sort by (scripts/runtime/access-ledger-lib.sh): "user visited / selected",
// never pane output. The phone's chat list no longer sorts by visits.

import (
	"encoding/json"
	"os"
	"path/filepath"
)

func accessLedgerFile() string {
	if p := os.Getenv("WEZDECK_ACCESS_LEDGER"); p != "" {
		return p
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local/state/wezterm-runtime/state/access-ledger.json")
}

// worktreeVisits maps worktree path → last access (ms). Fail-open: empty map.
func worktreeVisits() map[string]int64 {
	out := map[string]int64{}
	data, err := os.ReadFile(accessLedgerFile())
	if err != nil {
		return out
	}
	var doc struct {
		Worktrees map[string]struct {
			LastAccessMs int64 `json:"last_access_ms"`
		} `json:"worktrees"`
	}
	if json.Unmarshal(data, &doc) != nil {
		return out
	}
	for path, w := range doc.Worktrees {
		out[filepath.Clean(path)] = w.LastAccessMs
	}
	return out
}

// visitOf: the worktree's visit time, else the cwd's (a session started in a
// subdirectory, or outside git).
func visitOf(visits map[string]int64, worktree, cwd string) int64 {
	for _, p := range []string{worktree, cwd} {
		if p == "" {
			continue
		}
		if ms, ok := visits[filepath.Clean(p)]; ok {
			return ms
		}
	}
	return 0
}
