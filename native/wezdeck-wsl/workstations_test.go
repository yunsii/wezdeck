package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// a repo with two ux slots (ux clean, ux-2 dirty), a lone ci-2 and a
// ticket worktree; known through the access ledger; real worktree-task
func workstationFixture(t *testing.T) (repo string) {
	t.Helper()
	dir := t.TempDir()
	repo = filepath.Join(dir, "repo")
	git := func(args ...string) {
		t.Helper()
		if out, err := exec.Command("git", args...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %s", args, out)
		}
	}
	git("init", "-q", "-b", "main", repo)
	git("-C", repo, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "init")
	wt := filepath.Join(dir, ".worktrees", "repo")
	for _, s := range []string{"ux", "ux-2", "ci-2"} {
		git("-C", repo, "worktree", "add", "-q", "-b", "dev/"+s, filepath.Join(wt, s))
	}
	git("-C", repo, "worktree", "add", "-q", "-b", "ticket/req-1", filepath.Join(wt, "ticket-req-1"))
	git("-C", repo, "config", "branch.dev/ux-2.workstationDirection", "ux")
	git("-C", repo, "config", "branch.dev/ux.description", "网页控制台")
	os.WriteFile(filepath.Join(wt, "ux-2", "wip.txt"), []byte("wip"), 0o600)

	ledger := filepath.Join(dir, "ledger.json")
	os.WriteFile(ledger, []byte(fmt.Sprintf(`{"worktrees":{%q:{"last_access_ms":5},%q:{"last_access_ms":9}}}`,
		repo, filepath.Join(wt, "ux-2"))), 0o600)
	t.Setenv("WEZDECK_ACCESS_LEDGER", ledger)
	os.WriteFile(filepath.Join(dir, "attention.json"), []byte(`{"entries":{}}`), 0o600)
	t.Setenv("WEZDECK_ATTENTION_FILE", filepath.Join(dir, "attention.json"))
	cli, _ := filepath.Abs("../../scripts/runtime/worktree/worktree-task")
	t.Setenv("WEZDECK_WORKTREE_TASK_CMD", cli)
	t.Setenv("HOME", dir)
	return repo
}

func TestListWorkstationsGroupsByDirection(t *testing.T) {
	repo := workstationFixture(t)
	res, err := listWorkstations(json.RawMessage(fmt.Sprintf(`{"repo":%q}`, repo)))
	if err != nil {
		t.Fatal(err)
	}
	dirs := res.(map[string]any)["directions"].([]workstationDirection)
	if len(dirs) != 2 {
		t.Fatalf("directions: %+v", dirs)
	}
	ux := dirs[0] // visited latest (ux-2)
	if ux.Name != "ux" || ux.Description != "网页控制台" || ux.Idle != 1 || len(ux.Slots) != 2 {
		t.Fatalf("ux: %+v", ux)
	}
	if ux.Slots[0].Name != "ux-2" || ux.Slots[0].State != "dirty" || ux.Slots[1].State != "idle" {
		t.Fatalf("ux slots (newest visit first): %+v", ux.Slots)
	}
	if ux.Slots[0].Description != "" || ux.Slots[1].Description != "网页控制台" {
		t.Fatalf("slot descriptions: %+v", ux.Slots)
	}
	if dirs[1].Name != "ci-2" || dirs[1].Idle != 1 {
		t.Fatalf("ci-2 is its own direction: %+v", dirs[1])
	}
	if _, err := listWorkstations(json.RawMessage(`{"repo":"/etc"}`)); err == nil {
		t.Fatal("unknown repo accepted")
	}
}

func TestDirectionSlug(t *testing.T) {
	for in, want := range map[string]string{
		"ux": "ux", " Web UX ": "web-ux", "dev-ux": "ux", "dev/ux": "ux", "a__b": "a-b", "网页": "",
	} {
		if got := directionSlug(in); got != want {
			t.Errorf("%q: got %q want %q", in, got, want)
		}
	}
}

func TestNewSessionReusesAnIdleSlot(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux missing")
	}
	repo := workstationFixture(t)
	socket := filepath.Join("/tmp", "wd-reuse-"+newDiagID())
	t.Cleanup(func() { _ = exec.Command("tmux", "-S", socket, "kill-server").Run() })
	calls := filepath.Join(t.TempDir(), "calls")
	fake := func(kind string) string {
		p := filepath.Join(t.TempDir(), kind)
		os.WriteFile(p, []byte(`#!/usr/bin/env bash
echo "`+kind+` $*" >>`+calls+`
s="s$RANDOM"
tmux -S `+socket+` new-session -d -s "$s" -x 100 -y 20 "sh -c 'echo ready; exec cat'"
echo "worktree_path=${@: -1}"
echo "branch_name=dev/x"
echo "window_id=$(tmux -S `+socket+` display-message -p -t "$s" '#{window_id}')"
echo "tmux_socket=`+socket+`"
`), 0o755)
		return p
	}
	t.Setenv("WEZDECK_SESSION_REUSE_CMD", fake("reuse"))
	t.Setenv("WEZDECK_SESSION_NEW_CMD", fake("new"))

	start := func(name string) newSessionJob {
		raw, _ := json.Marshal(map[string]string{"repo": repo, "name": name, "prompt": "hello"})
		res, err := startNewSession(raw)
		if err != nil {
			t.Fatal(err)
		}
		return waitJob(t, res.(map[string]any)["job"].(string))
	}
	ux := filepath.Join(filepath.Dir(repo), ".worktrees", "repo", "ux")
	if j := start("ux"); j.Stage != "done" || j.Mode != "reuse" {
		t.Fatalf("ux: %+v", j)
	}
	// ux busy too (dirty) now: one more slot
	os.WriteFile(filepath.Join(ux, "wip.txt"), []byte("wip"), 0o600)
	if j := start("ux"); j.Stage != "done" || j.Mode != "parallel" {
		t.Fatalf("all busy: %+v", j)
	}
	if j := start("docs"); j.Stage != "done" || j.Mode != "new" {
		t.Fatalf("new direction: %+v", j)
	}
	log, _ := os.ReadFile(calls)
	lines := strings.Split(strings.TrimSpace(string(log)), "\n")
	if len(lines) != 3 || lines[0] != "reuse --no-attach "+ux ||
		!strings.HasPrefix(lines[1], "new --no-attach --description  -- ux") ||
		!strings.HasPrefix(lines[2], "new --no-attach --description  -- docs") {
		t.Fatalf("calls:\n%s", log)
	}
}
