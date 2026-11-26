package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestGroupedSessionStartsInSameCheckoutAndDeletesOnlyItsPane(t *testing.T) {
	dir, socket, original, _ := restartFixture(t)
	run := func(name string, args ...string) string {
		t.Helper()
		out, err := exec.Command(name, args...).CombinedOutput()
		if err != nil {
			t.Fatalf("%s: %v: %s", name, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	run("git", "init", "-q", dir)
	tmux := func(args ...string) string {
		return run("tmux", append([]string{"-S", socket}, args...)...)
	}
	tmux("respawn-pane", "-k", "-t", original, "-c", dir, filepath.Join(dir, "pane-bin", "claude"), "600")
	launcher := filepath.Join(dir, "scripts", "runtime", "agent-launcher.sh")
	run("mkdir", "-p", filepath.Dir(launcher))
	if err := os.WriteFile(launcher, []byte("#!/bin/bash\n[[ $WEZDECK_FORCE_FRESH_SESSION == 1 ]] || exit 1\necho ready\nexec cat\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WEZDECK_REPO", dir)
	t.Setenv("WEZDECK_SESSION_NEW_CMD", "fixture")
	result, err := startGroupedSession("s1", "grok", "answer in a separate conversation", "会话列表答疑")
	if err != nil {
		t.Fatal(err)
	}
	job := waitJob(t, result.(map[string]any)["job"].(string))
	if job.Stage != "done" || job.Worktree != dir || job.Warning != "" {
		t.Fatalf("job: %+v", job)
	}
	branch := run("git", "-C", dir, "symbolic-ref", "--short", "HEAD")
	if got := worktreeDescription(dir, branch); got != "会话列表答疑" {
		t.Fatalf("unexpected group name: %q", got)
	}
	pane := tmux("display-message", "-p", "-t", "work:"+filepath.Base(dir)+"-grok", "#{pane_id}")
	if pane == original || tmux("display-message", "-p", "-t", pane, "#{pane_current_path}") != dir {
		t.Fatalf("new pane %q did not start independently in %s", pane, dir)
	}
	if got := tmux("capture-pane", "-p", "-t", pane); !strings.Contains(got, "answer in a separate conversation") {
		t.Fatalf("first prompt missing: %s", got)
	}
	if _, err := deleteGroupedSession([]byte(`{"id":"s1"}`)); err == nil {
		t.Fatal("delete accepted without confirmation")
	}
	res, err := deleteGroupedSession([]byte(`{"id":"s1","confirm":true}`))
	if err != nil || res.(map[string]any)["worktree_outcome"] != "primary" {
		t.Fatalf("delete: %v, %v", res, err)
	}
	if got := tmux("list-panes", "-a", "-F", "#{pane_id}"); got != pane {
		t.Fatalf("delete affected the sibling pane: %q", got)
	}
	if !sessionWasClosed("s1") {
		t.Fatal("closed session marker missing")
	}
}

func TestGroupReclaimPreservesLocalFilesAndKeepsBranch(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(dir, "config"))
	t.Setenv("XDG_STATE_HOME", filepath.Join(dir, "state"))
	platform, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("WEZDECK_REPO", platform)
	repo := filepath.Join(dir, "repo")
	tree := filepath.Join(dir, ".worktrees", "repo", "group")
	git := func(args ...string) {
		t.Helper()
		if out, err := exec.Command("git", args...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	git("init", "-qb", "main", repo)
	git("-C", repo, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "--allow-empty", "-qm", "initial")
	git("-C", repo, "update-ref", "refs/remotes/origin/main", "HEAD")
	git("-C", repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
	git("-C", repo, "worktree", "add", "-qb", "dev/group", tree)
	localFile := filepath.Join(tree, "local.txt")
	if err := os.WriteFile(localFile, []byte("keep this"), 0600); err != nil {
		t.Fatal(err)
	}
	if got := reclaimEmptySessionWorktree(repo, tree); got != "dirty" {
		t.Fatalf("dirty worktree outcome: %s", got)
	}
	if err := os.Remove(localFile); err != nil {
		t.Fatal(err)
	}
	if got := reclaimEmptySessionWorktree(repo, tree); got != "removed" {
		t.Fatalf("clean worktree outcome: %s", got)
	}
	if _, err := os.Stat(tree); !os.IsNotExist(err) {
		t.Fatalf("worktree still exists: %v", err)
	}
	git("-C", repo, "show-ref", "--verify", "refs/heads/dev/group")
}
