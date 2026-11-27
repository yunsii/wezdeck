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
[[ "$1" == --no-attach && "$2" == --description && "$4" == -- ]] || { echo "bad args: $*" >&2; exit 2; }
echo "$3" >"$PWD/.fake-description"
tmux -S `+socket+` new-session -d -s fake -x 100 -y 20 "sh -c 'echo ready; exec cat'"
echo "branch_name=dev/${5}"
echo "worktree_path=$PWD/.worktrees/$5"
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
	raw, _ := json.Marshal(map[string]string{"repo": repo, "name": "phone", "description": "手机端体验", "prompt": "hello from the phone"})
	res, err := startNewSession(raw)
	if err != nil {
		t.Fatal(err)
	}
	j := waitJob(t, res.(map[string]any)["job"].(string))
	if j.Stage != "done" || j.Branch != "dev/phone" || !strings.HasSuffix(j.Worktree, "/.worktrees/phone") {
		t.Fatalf("job: %+v", j)
	}
	if got, _ := os.ReadFile(filepath.Join(repo, ".fake-description")); strings.TrimSpace(string(got)) != "手机端体验" {
		t.Fatalf("description not passed: %q", got)
	}
	screen, _ := exec.Command("tmux", "-S", socket, "capture-pane", "-p", "-t", "fake").Output()
	if !strings.Contains(string(screen), "hello from the phone") {
		t.Fatalf("first message not in the pane:\n%s", screen)
	}
}

func TestNewSessionValidates(t *testing.T) {
	repo, _ := newSessionFixture(t)
	cases := map[string]map[string]string{
		"name":        {"repo": repo, "name": "", "prompt": "p"},
		"old-subject": {"repo": repo, "type": "dev", "subject": "x", "prompt": "p"}, // a page from before 2026-11-25
		"no-ascii":    {"repo": repo, "name": "网页体验", "prompt": "p"},
		"newline":     {"repo": repo, "name": "a\nb", "prompt": "p"},
		"long":        {"repo": repo, "name": strings.Repeat("a", 61), "prompt": "p"},
		"desc-long":   {"repo": repo, "name": "x", "description": strings.Repeat("长", 121), "prompt": "p"},
		"desc-lines":  {"repo": repo, "name": "x", "description": "a\nb", "prompt": "p"},
		"message":     {"repo": repo, "name": "x", "prompt": "  "},
		"repo":        {"repo": "/etc", "name": "x", "prompt": "p"},
		"repo-sub":    {"repo": repo + "/../..", "name": "x", "prompt": "p"},
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

func TestAgyTrustRequiresVisiblePromptAndExplicitConfirmation(t *testing.T) {
	if !agyTrustPrompt("Do you trust the contents of this project?\n> Yes, I trust this folder\n  No, exit") {
		t.Fatal("Agy trust screen was not detected")
	}
	if kind, keys := detectWorkspaceTrustPrompt("Do you trust the contents of this project?\n> Yes, I trust this folder\n  No, exit"); kind != "agy" || strings.Join(keys, ",") != "Enter" {
		t.Fatalf("agy selected-yes keys: kind=%q keys=%v", kind, keys)
	}
	if kind, keys := detectWorkspaceTrustPrompt("Do you trust the contents of this project?\n  Yes, I trust this folder\n> No, exit"); kind != "agy" || strings.Join(keys, ",") != "Up,Enter" {
		t.Fatalf("agy selected-no keys: kind=%q keys=%v", kind, keys)
	}
	if kind, keys := detectWorkspaceTrustPrompt("Quick safety check: Is this a project you created or one you trust?\n❯ 1. Yes, I trust this folder"); kind != "claude" || strings.Join(keys, ",") != "Enter" {
		t.Fatalf("claude trust prompt: kind=%q keys=%v", kind, keys)
	}
	if kind, keys := detectWorkspaceTrustPrompt("Do you trust the contents of this directory?\n1. Yes, continue"); kind != "codex" || strings.Join(keys, ",") != "Enter" {
		t.Fatalf("codex trust prompt: kind=%q keys=%v", kind, keys)
	}
	if agyTrustPrompt("Welcome to Antigravity CLI") {
		t.Fatal("ordinary Agy screen was treated as a trust prompt")
	}
	if _, err := approveNewSessionTrust(json.RawMessage(`{"job":"missing"}`)); err == nil || !strings.Contains(err.Error(), "explicit confirmation") {
		t.Fatalf("trust without confirmation: %v", err)
	}
	if _, err := approveNewSessionTrust(json.RawMessage(`{"job":"missing","confirm":true}`)); err == nil || !strings.Contains(err.Error(), "no pending") {
		t.Fatalf("trust without pending job: %v", err)
	}
}

func TestNewSessionAutoConfirmsTrustAndCapturesSessionID(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux missing")
	}
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 missing")
	}
	repo, socket := newSessionFixture(t)
	attPath := os.Getenv("WEZDECK_ATTENTION_FILE")
	agentPy := filepath.Join(t.TempDir(), "fake_agent.py")
	pyBody := `import json, os, subprocess, sys
socket, att = sys.argv[1], sys.argv[2]
sys.stdout.write("Quick safety check: Is this a project you created or one you trust?\n❯ 1. Yes, I trust this folder\n  2. No, exit\n")
sys.stdout.flush()
sys.stdin.readline()
sys.stdout.write("\033[2J\033[HClaude ready\n")
sys.stdout.flush()
msg = sys.stdin.readline().strip()
sys.stdout.write(f"GOT:{msg}\n")
sys.stdout.flush()
pane = subprocess.check_output(["tmux", "-S", socket, "display-message", "-p", "-t", "fake", "#{pane_id}"], text=True).strip()
with open(att, "w", encoding="utf-8") as f:
    json.dump({"entries": {"sess-auto-1": {"session_id": "sess-auto-1", "tmux_socket": socket, "tmux_pane": pane, "status": "running"}}}, f)
for _ in sys.stdin:
    pass
`
	if err := os.WriteFile(agentPy, []byte(pyBody), 0o600); err != nil {
		t.Fatal(err)
	}
	fake := filepath.Join(t.TempDir(), "fake-trust-agent")
	script := `#!/usr/bin/env bash
set -e
tmux -S ` + socket + ` new-session -d -s fake -x 100 -y 20 "python3 ` + agentPy + ` ` + socket + ` ` + attPath + `"
echo "branch_name=dev/${5}"
echo "worktree_path=$PWD/.worktrees/$5"
echo "window_id=$(tmux -S ` + socket + ` display-message -p -t fake '#{window_id}')"
echo "tmux_socket=` + socket + `"
`
	if err := os.WriteFile(fake, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WEZDECK_SESSION_NEW_CMD", fake)
	// Omit agent_profile (repository default) to prove trust handling does not
	// depend on an explicit agent_profile=="agy".
	raw, _ := json.Marshal(map[string]string{"repo": repo, "name": "auto", "prompt": "run the check"})
	res, err := startNewSession(raw)
	if err != nil {
		t.Fatal(err)
	}
	j := waitJob(t, res.(map[string]any)["job"].(string))
	if j.Stage != "done" {
		t.Fatalf("job failed: %+v", j)
	}
	if j.SessionID != "sess-auto-1" {
		t.Fatalf("expected session_id=sess-auto-1, got %+v", j)
	}
	screen, _ := exec.Command("tmux", "-S", socket, "capture-pane", "-p", "-t", "fake").Output()
	if !strings.Contains(string(screen), "GOT:run the check") {
		t.Fatalf("first message did not reach agent after trust confirm:\n%s", screen)
	}
}

func TestAgyTrustConfirmationTargetsPendingPane(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux missing")
	}
	socket := filepath.Join(t.TempDir(), "trust.sock")
	command := exec.Command("tmux", "-S", socket, "new-session", "-d", "-s", "trust", "-x", "100", "-y", "20",
		"sh -c 'printf \"Do you trust the contents of this project?\\n> Yes, I trust this folder\\n  No, exit\\n\"; exec cat'")
	if out, err := command.CombinedOutput(); err != nil {
		t.Fatalf("tmux: %v: %s", err, out)
	}
	t.Cleanup(func() { _ = exec.Command("tmux", "-S", socket, "kill-server").Run() })
	pane, err := tmuxCmd(socket, "display-message", "-p", "-t", "trust", "#{pane_id}").Output()
	if err != nil {
		t.Fatal(err)
	}
	id := "agy-trust-test"
	ready := make(chan struct{}, 1)
	newJobsMu.Lock()
	newJobs[id] = &newSessionJob{ID: id, Stage: "waiting_trust", socket: socket, pane: strings.TrimSpace(string(pane)), trustCh: ready}
	newJobsMu.Unlock()
	t.Cleanup(func() { newJobsMu.Lock(); delete(newJobs, id); newJobsMu.Unlock() })
	deadline := time.Now().Add(2 * time.Second)
	for {
		screen, _ := tmuxCmd(socket, "capture-pane", "-p", "-t", strings.TrimSpace(string(pane))).Output()
		if agyTrustPrompt(string(screen)) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("fake Agy trust prompt did not paint")
		}
		time.Sleep(50 * time.Millisecond)
	}
	if _, err := approveNewSessionTrust(json.RawMessage(`{"job":"agy-trust-test","confirm":true}`)); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ready:
	default:
		t.Fatal("trust confirmation did not release the waiting job")
	}
	newJobsMu.Lock()
	stage := newJobs[id].Stage
	newJobsMu.Unlock()
	if stage != "starting" {
		t.Fatalf("stage after trust: %s", stage)
	}
}

func TestNewSessionFailureIsReported(t *testing.T) {
	repo, _ := newSessionFixture(t)
	fake := filepath.Join(t.TempDir(), "failing")
	os.WriteFile(fake, []byte("#!/usr/bin/env bash\necho 'worktree exists' >&2\nexit 1\n"), 0o755)
	t.Setenv("WEZDECK_SESSION_NEW_CMD", fake)
	raw, _ := json.Marshal(map[string]string{"repo": repo, "name": "x", "prompt": "p"})
	res, err := startNewSession(raw)
	if err != nil {
		t.Fatal(err)
	}
	if j := waitJob(t, res.(map[string]any)["job"].(string)); j.Stage != "failed" || !strings.Contains(j.Error, "worktree exists") {
		t.Fatalf("job: %+v", j)
	}
}

func TestNewSessionWithGroupNameAllocatesWorktree(t *testing.T) {
	repo, _ := newSessionFixture(t)
	raw, err := json.Marshal(map[string]string{
		"repo": repo, "group_name": "手机端体验", "prompt": "修复列表布局",
	})
	if err != nil {
		t.Fatal(err)
	}
	res, err := startNewSession(raw)
	if err != nil {
		t.Fatal(err)
	}
	job := waitJob(t, res.(map[string]any)["job"].(string))
	if job.Stage != "done" || job.Mode != "new" || !strings.HasPrefix(job.Branch, "dev/session-") {
		t.Fatalf("unexpected job: %+v", job)
	}
	got, err := os.ReadFile(filepath.Join(repo, ".fake-description"))
	if err != nil || strings.TrimSpace(string(got)) != "手机端体验" {
		t.Fatalf("group name was not saved: %q, %v", got, err)
	}
	if job.Prompt != "修复列表布局" || job.RepoLabel == "" || job.GroupName != "手机端体验" || job.CreatedAt == 0 {
		t.Fatalf("job missing guided metadata: %+v", job)
	}
}

func TestActiveNewSessionJobsExcludesListedDoneJobs(t *testing.T) {
	newJobsMu.Lock()
	saved := newJobs
	newJobs = map[string]*newSessionJob{
		"creating-1": {ID: "creating-1", Stage: "starting", Repo: "/tmp/r", RepoLabel: "r", Prompt: "p1", CreatedAt: 200, at: time.Now()},
		"failed-1":   {ID: "failed-1", Stage: "failed", Repo: "/tmp/r", RepoLabel: "r", Prompt: "p2", Error: "boom", CreatedAt: 150, at: time.Now()},
		"done-seen":  {ID: "done-seen", Stage: "done", SessionID: "s-1", CreatedAt: 100, at: time.Now()},
		"done-wt":    {ID: "done-wt", Stage: "done", Worktree: "/tmp/r/.worktrees/wt1", CreatedAt: 90, at: time.Now()},
		"done-fresh": {ID: "done-fresh", Stage: "done", Worktree: "/tmp/r/.worktrees/wt2", CreatedAt: 180, at: time.Now()},
	}
	newJobsMu.Unlock()
	t.Cleanup(func() {
		newJobsMu.Lock()
		newJobs = saved
		newJobsMu.Unlock()
	})
	got := activeNewSessionJobsFor([]sessionCard{
		{ID: "s-1", Worktree: "/tmp/r/.worktrees/s1"},
		{ID: "s-2", Worktree: "/tmp/r/.worktrees/wt1"},
	})
	if len(got) != 3 || got[0].ID != "creating-1" || got[1].ID != "done-fresh" || got[2].ID != "failed-1" {
		t.Fatalf("unexpected active jobs: %+v", got)
	}
}
