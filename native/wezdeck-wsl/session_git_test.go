package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestParseGitDetail(t *testing.T) {
	out := "# branch.oid abc\n# branch.head master\n# branch.upstream origin/master\n# branch.ab +1 -0\n" +
		"1 M. N... 100644 100644 100644 a b web/a b.ts\n" +
		"1 MM N... 100644 100644 100644 a b x.go\n" +
		"2 R. N... 100644 100644 100644 a b R100 new name.md\told.md\n" +
		"u UU N... 1 2 3 4 a b c c.go\n" +
		"? docs/new.md\n"
	d := parseGitDetail(out)
	if d.Branch != "master" || d.Upstream != "origin/master" || d.Status.Ahead != 1 {
		t.Fatalf("branch: %+v", d)
	}
	want := []gitFile{
		{"web/a b.ts", "staged", "M"},
		{"x.go", "staged", "M"}, {"x.go", "modified", "M"},
		{"new name.md", "staged", "R"},
		{"c.go", "conflict", "U"},
		{"docs/new.md", "untracked", "?"},
	}
	if len(d.Files) != len(want) {
		t.Fatalf("files %+v", d.Files)
	}
	for i := range want {
		if d.Files[i] != want[i] {
			t.Fatalf("file %d: %+v want %+v", i, d.Files[i], want[i])
		}
	}
}

func TestGitLogRealRepo(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	dir := t.TempDir()
	run := func(args ...string) {
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=a", "GIT_AUTHOR_EMAIL=a@x", "GIT_COMMITTER_NAME=a", "GIT_COMMITTER_EMAIL=a@x")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%v: %v %s", args, err, out)
		}
	}
	run("init", "-q")
	for _, msg := range []string{"first", "second: with | pipes"} {
		if err := os.WriteFile(filepath.Join(dir, msg[:3]), []byte(msg), 0o644); err != nil {
			t.Fatal(err)
		}
		run("add", ".")
		run("commit", "-q", "-m", msg)
	}
	got := gitLog(dir, "HEAD", 10)
	if len(got) != 2 || got[0].Subject != "second: with | pipes" || got[1].Subject != "first" || got[0].At == 0 || got[0].SHA == "" {
		t.Fatalf("log %+v", got)
	}
	if bad := gitLog(dir, "@{u}..HEAD", 10); len(bad) != 0 {
		t.Fatalf("no upstream: %+v", bad)
	}
}
