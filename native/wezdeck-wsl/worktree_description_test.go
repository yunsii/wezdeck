package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestWorktreeDescriptionReadsBranchDescriptions(t *testing.T) {
	repo := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		if out, err := exec.Command("git", append([]string{"-C", repo}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %s", args, out)
		}
	}
	run("init", "-q")
	run("config", "branch.dev/ux.description", "网页控制台体验")
	// git branch --edit-description writes a trailing newline and may hold
	// more lines: only the first is the purpose
	run("config", "branch.dev/ci.description", "CI 流水线\nsecond line")
	run("config", "branch.dev/a.b.description", "dotted branch")

	if got := worktreeDescription(repo, "dev/ux"); got != "网页控制台体验" {
		t.Fatalf("dev/ux: %q", got)
	}
	if got := worktreeDescription(repo, "dev/ci"); got != "CI 流水线" {
		t.Fatalf("dev/ci: %q", got)
	}
	if got := worktreeDescription(repo, "dev/a.b"); got != "dotted branch" {
		t.Fatalf("dev/a.b: %q", got)
	}
	if got := worktreeDescription(repo, "master"); got != "" {
		t.Fatalf("no description: %q", got)
	}
	if got := worktreeDescription("", "dev/ux"); got != "" {
		t.Fatalf("no repo: %q", got)
	}
	// a repository with none set at all (git exits 1)
	empty := t.TempDir()
	if out, err := exec.Command("git", "-C", empty, "init", "-q").CombinedOutput(); err != nil {
		t.Fatalf("git init: %s", out)
	}
	if got := worktreeDescription(empty, "dev/ux"); got != "" {
		t.Fatalf("empty repo: %q", got)
	}
}

func TestDescribeWorktreeSetsAndClears(t *testing.T) {
	dir := t.TempDir()
	repo := filepath.Join(dir, "repo")
	git := func(args ...string) {
		t.Helper()
		if out, err := exec.Command("git", args...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %s", args, out)
		}
	}
	git("init", "-q", "-b", "main", repo)
	git("-C", repo, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "init")
	ws := filepath.Join(dir, ".worktrees", "repo", "ux")
	git("-C", repo, "worktree", "add", "-q", "-b", "dev/ux", ws)
	ticket := filepath.Join(dir, ".worktrees", "repo", "ticket-req-1")
	git("-C", repo, "worktree", "add", "-q", "-b", "ticket/req-1", ticket)

	ledger := filepath.Join(dir, "ledger.json")
	os.WriteFile(ledger, []byte(fmt.Sprintf(`{"worktrees":{%q:{"last_access_ms":5}}}`, repo)), 0o600)
	t.Setenv("WEZDECK_ACCESS_LEDGER", ledger)
	os.WriteFile(filepath.Join(dir, "attention.json"), []byte(`{"entries":{}}`), 0o600)
	t.Setenv("WEZDECK_ATTENTION_FILE", filepath.Join(dir, "attention.json"))
	cli, _ := filepath.Abs("../../scripts/runtime/worktree/worktree-task")
	t.Setenv("WEZDECK_WORKTREE_TASK_CMD", cli)
	t.Setenv("HOME", dir)

	call := func(worktree, text string) error {
		raw, _ := json.Marshal(map[string]string{"worktree": worktree, "text": text})
		_, err := describeWorktree(raw)
		return err
	}
	if err := call(ws, "网页控制台体验"); err != nil {
		t.Fatal(err)
	}
	if got := worktreeDescription(repo, "dev/ux"); got != "网页控制台体验" {
		t.Fatalf("after set: %q", got)
	}
	if err := call(ws, ""); err != nil {
		t.Fatal(err)
	}
	if got := worktreeDescription(repo, "dev/ux"); got != "" {
		t.Fatalf("after clear: %q", got)
	}
	for name, c := range map[string][2]string{
		"primary":   {repo, "x"},
		"ticket":    {ticket, "x"},
		"multiline": {ws, "a\nb"},
		"unknown":   {t.TempDir(), "x"},
	} {
		if err := call(c[0], c[1]); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
