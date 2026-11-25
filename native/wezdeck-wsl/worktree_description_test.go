package main

import (
	"os/exec"
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
