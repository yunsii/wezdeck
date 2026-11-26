package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestGroupedSessionStartsInSameCheckoutAndDeletesOnlyItsPane(t *testing.T) {
	dir, socket, original, _ := restartFixture(t)
	t.Setenv("WEZDECK_ACCESS_LEDGER", filepath.Join(dir, "ledger.json"))
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
	dir, socket, pane, _ := restartFixture(t)
	t.Setenv("WEZDECK_ACCESS_LEDGER", filepath.Join(dir, "ledger.json"))
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
	if out, err := tmuxCmd(socket, "respawn-pane", "-k", "-t", pane, "-c", tree,
		filepath.Join(dir, "pane-bin", "claude"), "600").CombinedOutput(); err != nil {
		t.Fatalf("tmux respawn: %v: %s", err, out)
	}
	result, err := deleteGroupedSession([]byte(`{"id":"s1","confirm":true}`))
	if err != nil || result.(map[string]any)["worktree_outcome"] != "review_required" {
		t.Fatalf("normal delete: %v, %v", result, err)
	}
	if sessionWasClosed("s1") {
		t.Fatal("normal delete closed the session before review")
	}
	if _, err := os.Stat(localFile); err != nil {
		t.Fatalf("normal delete touched the worktree: %v", err)
	}
	result, err = deleteGroupedSession([]byte(`{"id":"s1","confirm":true,"force":true}`))
	if err != nil || result.(map[string]any)["worktree_outcome"] != "removed" {
		t.Fatalf("force delete: %v, %v", result, err)
	}
	if _, err := os.Stat(tree); !os.IsNotExist(err) {
		t.Fatalf("worktree still exists: %v", err)
	}
	git("-C", repo, "show-ref", "--verify", "refs/heads/dev/group")
	if repos := knownRepos(); len(repos) != 1 || repos[0].Root != repo {
		t.Fatalf("repository missing after deleting its last session: %+v", repos)
	}

}

func TestDeleteArchivedSessionPreservesReusedPane(t *testing.T) {
	dir, socket, pane, attention := restartFixture(t)
	t.Setenv("WEZDECK_ACCESS_LEDGER", filepath.Join(dir, "ledger.json"))
	run := func(name string, args ...string) {
		t.Helper()
		if out, err := exec.Command(name, args...).CombinedOutput(); err != nil {
			t.Fatalf("%s: %v: %s", name, err, out)
		}
	}
	run("git", "init", "-q", dir)
	run("tmux", "-S", socket, "respawn-pane", "-k", "-t", pane, "-c", dir,
		filepath.Join(dir, "pane-bin", "claude"), "600")
	run("tmux", "-S", socket, "set-option", "-p", "-t", pane, "@wezterm_agent_session_id", "new-session")
	doc := fmt.Sprintf(`{"recent":[{"session_id":"s1","tmux_socket":%q,"tmux_pane":%q,"agent_name":"claude","archived_ts":100}]}`, socket, pane)
	if err := os.WriteFile(attention, []byte(doc), 0600); err != nil {
		t.Fatal(err)
	}
	entry, _, _, err := sessionGroupTarget("s1")
	if err != nil || entry.archivedID != "s1" {
		t.Fatalf("archive fixture: %v", err)
	}
	result, err := deleteGroupedSession([]byte(`{"id":"s1","confirm":true}`))
	if err != nil || result.(map[string]any)["worktree_outcome"] != "archive_only" {
		t.Fatalf("archive delete: %v, %v", result, err)
	}
	if pin, err := sessionPanePin(entry); err != nil || pin != "new-session" {
		t.Fatalf("current pane changed: %q, %v", pin, err)
	}
	visible, err := liveSessions()
	if err != nil || visible["s1"].SessionID != "" {
		t.Fatalf("deleted archive still listed: %v", err)
	}
}
