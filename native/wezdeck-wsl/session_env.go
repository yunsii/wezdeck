package main

// The rest of the terminal's status line for the web console's bottom bar
// (web session-statusbar.tsx): the node version and the repo's worktrees.
//
// Node: the version the tmux status line resolved (tmux-status-line-main.sh
// caches it in /tmp/.tmux-status-node-cache: epoch, node path, version) — the
// relay runs without the person's fnm PATH, and reading that file shows the
// same version the terminal does. Absent until the status line ran once.
//
// Worktrees: `git worktree list --porcelain` of the pane's checkout, cached
// per directory for 30 s, bounded by a timeout.

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type worktreeInfo struct {
	Path    string `json:"path"`
	Branch  string `json:"branch,omitempty"`
	Current bool   `json:"current,omitempty"` // the session's own checkout
}

func nodeCacheFile() string {
	if p := os.Getenv("TMUX_STATUS_NODE_CACHE"); p != "" {
		return p
	}
	return "/tmp/.tmux-status-node-cache"
}

// terminalNodeVersion: the version the terminal shows, "" when unknown.
func terminalNodeVersion() string {
	data, err := os.ReadFile(nodeCacheFile())
	if err != nil {
		return ""
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) < 3 {
		return ""
	}
	v := strings.TrimSpace(lines[2])
	if !strings.HasPrefix(v, "v") || len(v) > 32 {
		return ""
	}
	return v
}

const (
	worktreesTTL     = 30 * time.Second
	worktreesTimeout = 800 * time.Millisecond
)

var (
	worktreesMu    sync.Mutex
	worktreesCache = map[string]struct {
		at   time.Time
		list []worktreeInfo
	}{}
)

// repoWorktrees: the worktrees of the checkout at cwd; nil outside a repo.
func repoWorktrees(cwd string) []worktreeInfo {
	if cwd == "" {
		return nil
	}
	worktreesMu.Lock()
	var prev []worktreeInfo
	if hit, ok := worktreesCache[cwd]; ok {
		if time.Since(hit.at) < worktreesTTL {
			worktreesMu.Unlock()
			return hit.list
		}
		prev = hit.list
	}
	worktreesMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), worktreesTimeout)
	defer cancel()
	var list []worktreeInfo
	top, err := exec.CommandContext(ctx, "git", "-C", cwd, "rev-parse", "--show-toplevel").Output()
	if err == nil {
		out, err := exec.CommandContext(ctx, "git", "-C", cwd, "worktree", "list", "--porcelain").Output()
		if err == nil {
			list = parseWorktrees(string(out), strings.TrimSpace(string(top)))
		}
	}
	if list == nil && ctx.Err() != nil && len(prev) > 0 {
		// Transient timeout: keep last good worktree list instead of hiding
		// the statusbar pill for 30s.
		list = prev
	}
	worktreesMu.Lock()
	worktreesCache[cwd] = struct {
		at   time.Time
		list []worktreeInfo
	}{time.Now(), list}
	worktreesMu.Unlock()
	return list
}

func parseWorktrees(out, current string) []worktreeInfo {
	var list []worktreeInfo
	for _, block := range strings.Split(strings.TrimSpace(out), "\n\n") {
		var w worktreeInfo
		for _, line := range strings.Split(block, "\n") {
			switch {
			case strings.HasPrefix(line, "worktree "):
				w.Path = strings.TrimPrefix(line, "worktree ")
			case strings.HasPrefix(line, "branch "):
				w.Branch = strings.TrimPrefix(strings.TrimPrefix(line, "branch "), "refs/heads/")
			case line == "detached":
				w.Branch = "(detached)"
			}
		}
		if w.Path == "" {
			continue
		}
		w.Current = filepath.Clean(w.Path) == filepath.Clean(current)
		list = append(list, w)
	}
	return list
}
