package main

// Guarded web management for a known workstation. The browser sends a path
// selected from workstations plus the HEAD it saw; the host rechecks both
// under the same lock used by session creation and deletion.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

func manageWorktree(action string, args json.RawMessage) (any, error) {
	var request struct {
		Worktree     string `json:"worktree"`
		ExpectedHead string `json:"expected_head"`
		Confirm      bool   `json:"confirm"`
	}
	if json.Unmarshal(args, &request) != nil || !request.Confirm ||
		!filepath.IsAbs(request.Worktree) || request.ExpectedHead == "" {
		return nil, errors.New("worktree management requires a selected HEAD and confirmation")
	}
	_, repo, tree := gitRepoMeta(request.Worktree)
	if tree != filepath.Clean(request.Worktree) || tree == repo || !isKnownRepo(repo) {
		return nil, errors.New("worktree is not a managed checkout of a known repository")
	}
	unlock, err := lockSessionWorktree(tree)
	if err != nil {
		return nil, err
	}
	defer unlock()
	newJobsMu.Lock()
	if reusing[tree] != "" {
		newJobsMu.Unlock()
		return nil, errors.New("another operation is using this worktree")
	}
	reusing[tree] = action
	newJobsMu.Unlock()
	defer releaseSessionWorktree(tree)

	directions, err := repoWorkstations(repo)
	if err != nil {
		return nil, err
	}
	var slot *workstationSlot
	for _, direction := range directions {
		for i := range direction.Slots {
			if direction.Slots[i].Path == tree {
				slot = &direction.Slots[i]
				break
			}
		}
	}
	if slot == nil || !strings.HasPrefix(slot.Branch, "dev/") {
		return nil, errors.New("worktree is not a managed development workstation")
	}
	if slot.Head != request.ExpectedHead {
		return nil, errors.New("worktree HEAD changed; refresh and review it again")
	}
	if slot.State == "running" || slot.State == "waiting" {
		return nil, errors.New("the agent is working in this worktree")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(ctx, "git", "-C", repo, "fetch", "origin", "--quiet").CombinedOutput(); err != nil {
		detail := strings.TrimSpace(string(out))
		if detail == "" {
			detail = err.Error()
		}
		return nil, fmt.Errorf("cannot refresh the default branch: %s", clip(detail, 200))
	}
	if head, err := exec.Command("git", "-C", tree, "rev-parse", "HEAD").Output(); err != nil || strings.TrimSpace(string(head)) != request.ExpectedHead {
		return nil, errors.New("worktree HEAD changed; refresh and review it again")
	}
	if state, reason := gitIdle(tree); state != "idle" {
		return nil, fmt.Errorf("worktree is not ready (%s): %s", state, reason)
	}
	if busyWorktrees()[tree] != "" {
		return nil, errors.New("the agent started working in this worktree")
	}

	switch action {
	case "worktree.remove":
		if outcome := reclaimSessionWorktree(repo, tree, false); outcome != "removed" {
			return nil, fmt.Errorf("worktree was not removed: %s", outcome)
		}
		return map[string]any{"v": 1, "ok": true, "outcome": "removed"}, nil
	case "worktree.recycle":
		cmdPath := os.Getenv("WEZDECK_WORKTREE_TASK_CMD")
		if cmdPath == "" {
			cmdPath = filepath.Join(repoRoot(), "scripts", "runtime", "worktree", "worktree-task")
		}
		runCtx, stop := context.WithTimeout(context.Background(), 75*time.Second)
		defer stop()
		cmd := exec.CommandContext(runCtx, cmdPath, "recycle", "--worktree-root", tree,
			"--require-delivered", "--no-clean-files", "--keep-temp-branches", "--fresh-agent", "-y")
		cmd.Dir = repo
		if out, err := cmd.CombinedOutput(); err != nil {
			return nil, fmt.Errorf("worktree recycle failed: %s", clip(strings.TrimSpace(string(out)), 300))
		}
		return map[string]any{"v": 1, "ok": true, "outcome": "recycled"}, nil
	default:
		return nil, errors.New("unsupported worktree action")
	}
}
