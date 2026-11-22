package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWorktreeVisits(t *testing.T) {
	dir := t.TempDir()
	ledger := filepath.Join(dir, "access-ledger.json")
	t.Setenv("WEZDECK_ACCESS_LEDGER", ledger)
	if got := worktreeVisits(); len(got) != 0 {
		t.Fatalf("missing ledger: want empty, got %v", got)
	}
	os.WriteFile(ledger, []byte(`{"version":1,"worktrees":{"/r/main/":{"last_access_ms":5},"/r/.worktrees/dev-a":{"last_access_ms":9}}}`), 0o600)
	visits := worktreeVisits()
	if visitOf(visits, "/r/main", "/r/main/sub") != 5 {
		t.Fatalf("worktree match (trailing slash cleaned): %v", visits)
	}
	if visitOf(visits, "", "/r/.worktrees/dev-a") != 9 {
		t.Fatal("cwd fallback")
	}
	if visitOf(visits, "/elsewhere", "/elsewhere") != 0 {
		t.Fatal("unknown path is 0")
	}
	os.WriteFile(ledger, []byte(`{bad`), 0o600)
	if len(worktreeVisits()) != 0 {
		t.Fatal("corrupt ledger fails open")
	}
}
