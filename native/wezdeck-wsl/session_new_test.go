package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// a repo the access ledger knows, an empty attention file, and a fake
// open-task-window that opens a `cat` pane on a private tmux socket
func newSessionFixture(t *testing.T) (repo, socket string) {
	t.Helper()
	dir := t.TempDir()
	repo = filepath.Join(dir, "repo")
	if out, err := exec.Command("git", "init", "-q", repo).CombinedOutput(); err != nil {
		t.Fatalf("git init: %s", out)
	}
	ledger := filepath.Join(dir, "ledger.json")
	os.WriteFile(ledger, []byte(fmt.Sprintf(`{"worktrees":{%q:{"last_access_ms":5}}}`, repo)), 0o600)
	t.Setenv("WEZDECK_ACCESS_LEDGER", ledger)
	os.WriteFile(filepath.Join(dir, "attention.json"), []byte(`{"entries":{}}`), 0o600)
	t.Setenv("WEZDECK_ATTENTION_FILE", filepath.Join(dir, "attention.json"))
	socket = filepath.Join("/tmp", "wd-new-"+newDiagID())
	t.Cleanup(func() { _ = exec.Command("tmux", "-S", socket, "kill-server").Run() })
	fake := filepath.Join(dir, "fake-open-task-window")
	os.WriteFile(fake, []byte(`#!/usr/bin/env bash
set -e
[[ "$1" == --no-attach && "$2" == --type ]] || { echo "bad args: $*" >&2; exit 2; }
tmux -S `+socket+` new-session -d -s fake -x 100 -y 20 "sh -c 'echo ready; exec cat'"
echo "branch_name=$3/${5}"
echo "worktree_path=$PWD/.worktrees/$3-$5"
echo "window_id=$(tmux -S `+socket+` display-message -p -t fake '#{window_id}')"
echo "tmux_socket=`+socket+`"
`), 0o755)
	t.Setenv("WEZDECK_SESSION_NEW_CMD", fake)
	return repo, socket
}

func waitJob(t *testing.T, job string) newSessionJob {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		res, err := newSessionJobStatus(json.RawMessage(fmt.Sprintf(`{"job":%q}`, job)))
		if err != nil {
			t.Fatal(err)
		}
		j := res.(map[string]any)["job"].(newSessionJob)
		if j.Stage == "done" || j.Stage == "failed" {
			return j
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatal("job did not finish")
	return newSessionJob{}
}

func TestNewSessionEndToEnd(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux missing")
	}
	repo, socket := newSessionFixture(t)
	raw, _ := json.Marshal(map[string]string{"repo": repo, "type": "dev", "subject": "phone", "prompt": "hello from the phone"})
	res, err := startNewSession(raw)
	if err != nil {
		t.Fatal(err)
	}
	j := waitJob(t, res.(map[string]any)["job"].(string))
	if j.Stage != "done" || j.Branch != "dev/phone" || !strings.HasSuffix(j.Worktree, "dev-phone") {
		t.Fatalf("job: %+v", j)
	}
	screen, _ := exec.Command("tmux", "-S", socket, "capture-pane", "-p", "-t", "fake").Output()
	if !strings.Contains(string(screen), "hello from the phone") {
		t.Fatalf("first message not in the pane:\n%s", screen)
	}
}

func TestNewSessionValidates(t *testing.T) {
	repo, _ := newSessionFixture(t)
	cases := map[string]map[string]string{
		"type":     {"repo": repo, "type": "feature", "subject": "x", "prompt": "p"},
		"subject":  {"repo": repo, "type": "dev", "subject": "", "prompt": "p"},
		"newline":  {"repo": repo, "type": "dev", "subject": "a\nb", "prompt": "p"},
		"long":     {"repo": repo, "type": "dev", "subject": strings.Repeat("长", 61), "prompt": "p"},
		"message":  {"repo": repo, "type": "dev", "subject": "x", "prompt": "  "},
		"repo":     {"repo": "/etc", "type": "dev", "subject": "x", "prompt": "p"},
		"repo-sub": {"repo": repo + "/../..", "type": "dev", "subject": "x", "prompt": "p"},
	}
	for name, args := range cases {
		raw, _ := json.Marshal(args)
		if _, err := startNewSession(raw); err == nil {
			t.Errorf("%s: accepted %v", name, args)
		}
	}
	if repos := knownRepos(); len(repos) != 1 || repos[0].Root != repo {
		t.Fatalf("known repos: %+v", repos)
	}
}

func TestNewSessionFailureIsReported(t *testing.T) {
	repo, _ := newSessionFixture(t)
	fake := filepath.Join(t.TempDir(), "failing")
	os.WriteFile(fake, []byte("#!/usr/bin/env bash\necho 'worktree exists' >&2\nexit 1\n"), 0o755)
	t.Setenv("WEZDECK_SESSION_NEW_CMD", fake)
	raw, _ := json.Marshal(map[string]string{"repo": repo, "type": "task", "subject": "x", "prompt": "p"})
	res, err := startNewSession(raw)
	if err != nil {
		t.Fatal(err)
	}
	if j := waitJob(t, res.(map[string]any)["job"].(string)); j.Stage != "failed" || !strings.Contains(j.Error, "worktree exists") {
		t.Fatalf("job: %+v", j)
	}
}
