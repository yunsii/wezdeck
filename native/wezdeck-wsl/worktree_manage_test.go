package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestManageWorktreeGuardsAndActions(t *testing.T) {
	repo := workstationFixture(t)
	git := func(args ...string) string {
		t.Helper()
		out, err := exec.Command("git", args...).CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %s", args, out)
		}
		return strings.TrimSpace(string(out))
	}
	remote := filepath.Join(t.TempDir(), "origin.git")
	git("init", "-q", "--bare", remote)
	git("-C", repo, "remote", "add", "origin", remote)
	git("-C", repo, "push", "-q", "-u", "origin", "main")
	git("-C", remote, "symbolic-ref", "HEAD", "refs/heads/main")
	git("-C", repo, "remote", "set-head", "origin", "-a")

	ux := filepath.Join(filepath.Dir(repo), ".worktrees", "repo", "ux")
	dirty := filepath.Join(filepath.Dir(repo), ".worktrees", "repo", "ux-2")
	ci := filepath.Join(filepath.Dir(repo), ".worktrees", "repo", "ci-2")
	ticket := filepath.Join(filepath.Dir(repo), ".worktrees", "repo", "ticket-req-1")
	head := git("-C", ux, "rev-parse", "HEAD")
	call := func(action, path, expected string, confirm bool) error {
		t.Helper()
		raw, _ := json.Marshal(map[string]any{
			"worktree": path, "expected_head": expected, "confirm": confirm,
		})
		_, err := manageWorktree(action, raw)
		return err
	}
	denied := func(action, path, expected string, confirm bool, reason string) {
		t.Helper()
		if err := call(action, path, expected, confirm); err == nil || !strings.Contains(err.Error(), reason) {
			t.Fatalf("%s %s: wanted %q, got %v", action, path, reason, err)
		}
	}
	denied("worktree.recycle", ux, head, false, "confirmation")
	denied("worktree.recycle", ux, "stale", true, "HEAD changed")
	denied("worktree.recycle", repo, head, true, "not a managed checkout")
	denied("worktree.remove", ticket, head, true, "not a managed development")
	denied("worktree.remove", dirty, "stale", true, "HEAD changed")
	dirtyHead := git("-C", dirty, "rev-parse", "HEAD")
	denied("worktree.remove", dirty, dirtyHead, true, "not ready")

	newJobsMu.Lock()
	reusing[ux] = "another-job"
	newJobsMu.Unlock()
	denied("worktree.recycle", ux, head, true, "another operation")
	releaseSessionWorktree(ux)

	if err := os.WriteFile(filepath.Join(ux, "unique.txt"), []byte("not delivered\n"), 0600); err != nil {
		t.Fatal(err)
	}
	git("-C", ux, "add", "unique.txt")
	git("-C", ux, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "-m", "not-delivered")
	undeliveredHead := git("-C", ux, "rev-parse", "HEAD")
	denied("worktree.recycle", ux, undeliveredHead, true, "not ready")
	git("-C", repo, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "main-updated")
	git("-C", repo, "push", "-q", "origin", "main")

	ciHead := git("-C", ci, "rev-parse", "HEAD")
	raw, _ := json.Marshal(map[string]any{"worktree": ci, "expected_head": ciHead, "confirm": true})
	if _, err := manageWorktree("worktree.recycle", raw); err != nil {
		t.Fatalf("recycle: %v", err)
	}
	if got, want := git("-C", ci, "rev-parse", "HEAD"), git("-C", repo, "rev-parse", "origin/HEAD"); got != want {
		t.Fatalf("recycled HEAD %s, want %s", got, want)
	}
	denied("worktree.remove", ci, ciHead, true, "HEAD changed")
	newHead := git("-C", ci, "rev-parse", "HEAD")
	held := exec.Command("sleep", "10")
	held.Dir = ci
	if err := held.Start(); err != nil {
		t.Fatal(err)
	}
	denied("worktree.remove", ci, newHead, true, "in_use")
	_ = held.Process.Kill()
	_ = held.Wait()
	raw, _ = json.Marshal(map[string]any{"worktree": ci, "expected_head": newHead, "confirm": true})
	if _, err := manageWorktree("worktree.remove", raw); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if _, err := os.Stat(ci); !os.IsNotExist(err) {
		t.Fatalf("worktree still exists: %v", err)
	}
	git("-C", repo, "show-ref", "--verify", "refs/heads/dev/ci-2")
}
