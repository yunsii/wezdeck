package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestTerminalNodeVersion(t *testing.T) {
	p := filepath.Join(t.TempDir(), "node-cache")
	t.Setenv("TMUX_STATUS_NODE_CACHE", p)
	if terminalNodeVersion() != "" {
		t.Fatal("no cache: empty")
	}
	if err := os.WriteFile(p, []byte("1795569416\n/x/bin/node\nv22.23.1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := terminalNodeVersion(); got != "v22.23.1" {
		t.Fatalf("got %q", got)
	}
	_ = os.WriteFile(p, []byte("1\n/x\nnot-a-version\n"), 0o600)
	if terminalNodeVersion() != "" {
		t.Fatal("junk: empty")
	}
}

func TestParseWorktrees(t *testing.T) {
	out := "worktree /r/main\nHEAD a\nbranch refs/heads/master\n\n" +
		"worktree /r/.worktrees/dev-agent\nHEAD b\nbranch refs/heads/dev/agent\n\n" +
		"worktree /r/.worktrees/probe\nHEAD c\ndetached\n"
	got := parseWorktrees(out, "/r/.worktrees/dev-agent")
	if len(got) != 3 || got[0].Branch != "master" || got[1].Branch != "dev/agent" || !got[1].Current || got[0].Current || got[2].Branch != "(detached)" {
		t.Fatalf("%+v", got)
	}
}
