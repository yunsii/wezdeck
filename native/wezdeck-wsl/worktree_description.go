package main

// A workstation's one-line purpose for the session list: the git branch
// description (branch.<b>.description, set by `worktree-task describe` /
// the new-workstation prompt / the web console's 新会话). One
// `git config --get-regexp` per repository, cached briefly: the list is
// polled every few seconds and descriptions change rarely.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
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

// `worktree.describe {worktree, text}` (signed write): set — or with empty
// text, clear — a workstation's purpose from the web console, through the
// same `worktree-task describe` the CLI and the Alt+g editor run. The
// worktree must be a linked worktree of a repository you work in (one of
// knownRepos), not its primary checkout and not an agent-collab ticket-* /
// OpenClaw claw-* one.
func describeWorktree(args json.RawMessage) (any, error) {
	var a struct {
		Worktree string `json:"worktree"`
		Text     string `json:"text"`
	}
	if json.Unmarshal(args, &a) != nil || a.Worktree == "" {
		return nil, errors.New("worktree.describe: bad arguments")
	}
	a.Text = strings.TrimSpace(a.Text)
	if utf8.RuneCountInString(a.Text) > descriptionMax || strings.ContainsAny(a.Text, "\r\n") {
		return nil, fmt.Errorf("worktree.describe: the purpose is one line of at most %d characters", descriptionMax)
	}
	_, root, wt := gitRepoMeta(a.Worktree)
	if wt == "" || filepath.Clean(wt) != filepath.Clean(a.Worktree) || root == "" || root == wt {
		return nil, errors.New("worktree.describe: not a workstation (a linked worktree)")
	}
	if base := filepath.Base(wt); strings.HasPrefix(base, "ticket-") || strings.HasPrefix(base, "claw-") {
		return nil, errors.New("worktree.describe: ticket-* / claw-* worktrees belong to agent-collab / OpenClaw")
	}
	known := false
	for _, r := range knownRepos() {
		known = known || r.Root == root
	}
	if !known {
		return nil, errors.New("worktree.describe: not a repository you work in")
	}
	cmdPath := os.Getenv("WEZDECK_WORKTREE_TASK_CMD") // the test stack's stand-in
	if cmdPath == "" {
		cmdPath = filepath.Join(repoRoot(), "scripts", "runtime", "worktree", "worktree-task")
	}
	cmdArgs := []string{"describe", "--cwd", wt}
	if a.Text == "" {
		cmdArgs = append(cmdArgs, "--clear")
	} else {
		cmdArgs = append(cmdArgs, "--set", a.Text)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(ctx, cmdPath, cmdArgs...).CombinedOutput(); err != nil {
		return nil, fmt.Errorf("worktree.describe: %s", clip(strings.TrimSpace(string(out)), 300))
	}
	worktreeDescMu.Lock()
	delete(worktreeDescCache, root) // the next sessions poll reads it fresh
	worktreeDescMu.Unlock()
	relayLogf("worktree_describe", "worktree=%q chars=%d", wt, utf8.RuneCountInString(a.Text))
	return map[string]any{"v": 1, "ok": true, "description": a.Text}, nil
}
