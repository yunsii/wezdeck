package main

// Working-tree git status for the session header: the same counts the tmux
// status line shows (tmux-status-line-main.sh `(+staged,~unstaged,?untracked`
// plus ahead / behind), from one `git status --porcelain=v2 --branch`. Cached
// per directory for a few seconds — the page polls the session every ~second
// — and bounded by a timeout so a slow repo never stalls the reply.

import (
	"context"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

type gitStatus struct {
	Staged    int  `json:"staged"`
	Unstaged  int  `json:"unstaged"`
	Untracked int  `json:"untracked"`
	Upstream  bool `json:"upstream"`
	Ahead     int  `json:"ahead"`
	Behind    int  `json:"behind"`
}

const (
	gitStatusTTL     = 5 * time.Second
	gitStatusTimeout = 800 * time.Millisecond
	gitStatusSlow    = 300 * time.Millisecond
)

var (
	gitStatusMu    sync.Mutex
	gitStatusCache = map[string]gitStatusEntry{}
)

type gitStatusEntry struct {
	at     time.Time
	status *gitStatus
}

// worktreeGitStatus: nil outside a repo, when git fails or times out.
func worktreeGitStatus(cwd string) *gitStatus {
	if cwd == "" {
		return nil
	}
	gitStatusMu.Lock()
	if hit, ok := gitStatusCache[cwd]; ok && time.Since(hit.at) < gitStatusTTL {
		gitStatusMu.Unlock()
		return hit.status
	}
	gitStatusMu.Unlock()

	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), gitStatusTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "git", "-C", cwd, "status", "--porcelain=v2", "--branch", "--untracked-files=all").Output()
	took := time.Since(start)
	var status *gitStatus
	if err == nil {
		status = parseGitStatus(string(out))
	}
	if took >= gitStatusSlow || ctx.Err() != nil {
		relayLogf("git_status", "cwd=%q ms=%d ok=%t", cwd, took.Milliseconds(), status != nil)
	}
	gitStatusMu.Lock()
	gitStatusCache[cwd] = gitStatusEntry{at: time.Now(), status: status}
	gitStatusMu.Unlock()
	return status
}

func parseGitStatus(out string) *gitStatus {
	s := &gitStatus{}
	for _, line := range strings.Split(out, "\n") {
		switch {
		case strings.HasPrefix(line, "# branch.upstream "):
			s.Upstream = true
		case strings.HasPrefix(line, "# branch.ab "):
			for _, f := range strings.Fields(strings.TrimPrefix(line, "# branch.ab ")) {
				n, _ := strconv.Atoi(f[1:])
				if f[0] == '+' {
					s.Ahead = n
				} else if f[0] == '-' {
					s.Behind = n
				}
			}
		case strings.HasPrefix(line, "1 "), strings.HasPrefix(line, "2 "), strings.HasPrefix(line, "u "):
			if len(line) < 4 {
				continue
			}
			if x := line[2]; x != '.' && x != ' ' {
				s.Staged++
			}
			if y := line[3]; y != '.' && y != ' ' {
				s.Unstaged++
			}
		case strings.HasPrefix(line, "? "):
			s.Untracked++
		}
	}
	return s
}
