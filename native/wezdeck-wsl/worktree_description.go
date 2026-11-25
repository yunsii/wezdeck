package main

// A workstation's one-line purpose for the session list: the git branch
// description (branch.<b>.description, set by `worktree-task describe` /
// the new-workstation prompt / the web console's 新会话). One
// `git config --get-regexp` per repository, cached briefly: the list is
// polled every few seconds and descriptions change rarely.

import (
	"bytes"
	"context"
	"os/exec"
	"strings"
	"sync"
	"time"
)

const worktreeDescriptionTTL = 30 * time.Second

type repoDescriptions struct {
	at    time.Time
	byKey map[string]string // branch → first line of its description
}

var (
	worktreeDescMu    sync.Mutex
	worktreeDescCache = map[string]repoDescriptions{}
)

// worktreeDescription: the purpose of <branch> in the repository at
// repoRoot, "" when either is unknown or nothing is set.
func worktreeDescription(repoRoot, branch string) string {
	if repoRoot == "" || branch == "" {
		return ""
	}
	worktreeDescMu.Lock()
	cached, ok := worktreeDescCache[repoRoot]
	worktreeDescMu.Unlock()
	if !ok || time.Since(cached.at) > worktreeDescriptionTTL {
		cached = repoDescriptions{at: time.Now(), byKey: readBranchDescriptions(repoRoot)}
		worktreeDescMu.Lock()
		worktreeDescCache[repoRoot] = cached
		worktreeDescMu.Unlock()
	}
	return cached.byKey[branch]
}

// readBranchDescriptions parses `git config -z --get-regexp`: NUL-separated
// records of "key\nvalue"; a multi-line description (git branch
// --edit-description) keeps its first line.
func readBranchDescriptions(repoRoot string) map[string]string {
	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()
	out, err := exec.CommandContext(ctx, "git", "-C", repoRoot, "config", "-z",
		"--get-regexp", `^branch\..*\.description$`).Output()
	byKey := map[string]string{}
	if err != nil { // exit 1: none set
		return byKey
	}
	for _, rec := range bytes.Split(out, []byte{0}) {
		key, value, ok := strings.Cut(string(rec), "\n")
		if !ok {
			continue
		}
		branch, ok := strings.CutPrefix(key, "branch.")
		if !ok {
			continue
		}
		branch, ok = strings.CutSuffix(branch, ".description")
		if !ok || branch == "" {
			continue
		}
		first, _, _ := strings.Cut(value, "\n")
		if first = strings.TrimSpace(first); first != "" {
			byKey[branch] = first
		}
	}
	return byKey
}
