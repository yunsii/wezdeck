package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestParseGitStatus(t *testing.T) {
	out := "# branch.oid abc\n# branch.head master\n# branch.upstream origin/master\n# branch.ab +2 -3\n" +
		"1 M. N... 100644 100644 100644 a b x.go\n" +
		"1 .M N... 100644 100644 100644 a b y.go\n" +
		"1 MM N... 100644 100644 100644 a b z.go\n" +
		"2 R. N... 100644 100644 100644 a b R100 new\told\n" +
		"u UU N... 1 2 3 4 a b c conflict.go\n" +
		"? new.txt\n? other.txt\n"
	got := *parseGitStatus(out)
	want := gitStatus{Staged: 4, Unstaged: 3, Untracked: 2, Upstream: true, Ahead: 2, Behind: 3}
	if got != want {
		t.Fatalf("got %+v want %+v", got, want)
	}
	if got := *parseGitStatus("# branch.head x\n"); got != (gitStatus{}) {
		t.Fatalf("no upstream: got %+v", got)
	}
}

func TestWorktreeGitStatusRealRepo(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	dir := t.TempDir()
	if out, err := exec.Command("git", "-C", dir, "init", "-q").CombinedOutput(); err != nil {
		t.Fatalf("git init: %v %s", err, out)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	// a new directory counts by file, not as one `dir/` entry
	if err := os.MkdirAll(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"b.txt", "c.txt"} {
		if err := os.WriteFile(filepath.Join(dir, "sub", name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got := worktreeGitStatus(dir)
	if got == nil || got.Untracked != 3 || got.Upstream {
		t.Fatalf("got %+v", got)
	}
	if worktreeGitStatus(t.TempDir()) != nil {
		t.Fatal("outside a repo should be nil")
	}
}
