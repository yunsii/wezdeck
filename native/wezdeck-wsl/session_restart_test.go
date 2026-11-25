package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// a private tmux server with one pane whose process looks like Claude
// (agent-ctrl-n detects it from the cmdline), an attention file listing
// session s1 on it, and the runtime state sandboxed so pins and logs never
// touch the live state
func restartFixture(t *testing.T) (dir, socket, pane, attention string) {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux missing")
	}
	dir = t.TempDir()
	for _, v := range []string{"WINDOWS_RUNTIME_STATE_WSL", "LOCALAPPDATA_WSL", "USERPROFILE_WSL"} {
		p := filepath.Join(dir, strings.ToLower(v))
		_ = os.MkdirAll(p, 0o755)
		t.Setenv(v, p)
	}
	t.Setenv("XDG_STATE_HOME", filepath.Join(dir, "state"))
	socket = filepath.Join("/tmp", "wd-restart-"+newDiagID())
	t.Cleanup(func() { _ = exec.Command("tmux", "-S", socket, "kill-server").Run() })
	// a process named claude: the relay lists an archived entry only while
	// its pane still runs an agent
	// (in a directory of its own: never write through this link)
	sleep, _ := exec.LookPath("sleep")
	_ = os.MkdirAll(filepath.Join(dir, "pane-bin"), 0o755)
	_ = os.Symlink(sleep, filepath.Join(dir, "pane-bin", "claude"))
	if out, err := exec.Command("tmux", "-S", socket, "new-session", "-d", "-s", "work", "-x", "100", "-y", "20",
		filepath.Join(dir, "pane-bin", "claude")+" 600").CombinedOutput(); err != nil {
		t.Fatalf("tmux: %s", out)
	}
	out, _ := exec.Command("tmux", "-S", socket, "display-message", "-p", "-t", "work", "#{pane_id}").Output()
	pane = strings.TrimSpace(string(out))
	attention = filepath.Join(dir, "attention.json")
	doc, _ := json.Marshal(map[string]any{"entries": map[string]any{"s1": map[string]any{
		"session_id": "s1", "status": "done", "ts": 100, "tmux_socket": socket,
		"tmux_session": "work", "tmux_pane": pane, "agent_name": "claude"}}})
	_ = os.WriteFile(attention, doc, 0o600)
	t.Setenv("WEZDECK_ATTENTION_FILE", attention)
	return dir, socket, pane, attention
}

func TestRestartSessionPassesPaneAndSocket(t *testing.T) {
	dir, socket, pane, _ := restartFixture(t)
	record := filepath.Join(dir, "argv")
	stub := filepath.Join(dir, "restart-stub")
	_ = os.WriteFile(stub, []byte(`#!/usr/bin/env bash
printf '%s|%s\n' "$*" "$TMUX" >>`+record+`
[[ " $* " == *" --fresh "* ]] && echo session_id=11111111-2222-3333-4444-555555555555
echo outcome=respawned
`), 0o755)
	t.Setenv("WEZDECK_SESSION_RESTART_CMD", stub)

	res, err := restartSession([]byte(`{"id":"s1"}`))
	if err != nil {
		t.Fatal(err)
	}
	if m := res.(map[string]any); m["session_id"] != nil || m["fresh"] != false {
		t.Fatalf("resume reply: %v", m)
	}
	res, err = restartSession([]byte(`{"id":"s1","fresh":true}`))
	if err != nil {
		t.Fatal(err)
	}
	if m := res.(map[string]any); m["session_id"] != "11111111-2222-3333-4444-555555555555" {
		t.Fatalf("fresh reply: %v", m)
	}
	got, _ := os.ReadFile(record)
	lines := strings.Split(strings.TrimSpace(string(got)), "\n")
	if len(lines) != 2 || !strings.HasPrefix(lines[0], "--pane "+pane) || !strings.Contains(lines[1], "--fresh") ||
		!strings.HasSuffix(lines[0], "|"+socket+",0,0") {
		t.Fatalf("argv / TMUX: %q", lines)
	}
}

func TestRestartSessionReportsFailure(t *testing.T) {
	dir, _, _, _ := restartFixture(t)
	stub := filepath.Join(dir, "restart-stub")
	_ = os.WriteFile(stub, []byte("#!/usr/bin/env bash\necho outcome=failed:no_current_window\nexit 1\n"), 0o755)
	t.Setenv("WEZDECK_SESSION_RESTART_CMD", stub)
	if _, err := restartSession([]byte(`{"id":"s1"}`)); err == nil || !strings.Contains(err.Error(), "restart failed") {
		t.Fatalf("want restart failed, got %v", err)
	}
	if _, err := restartSession([]byte(`{"id":"nope"}`)); err == nil {
		t.Fatal("an unlisted session must be refused")
	}
}

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// the real script, fresh: the respawn itself is a stub (AGENT_CTRL_N_FRESH_SH),
// the rest is real — agent detection, the id handed to the pane, and the old
// entry archived and marked cleared_to the new id, so the page can follow
func TestSessionRestartScriptFreshMarksClearedTo(t *testing.T) {
	dir, socket, pane, attention := restartFixture(t)
	called := filepath.Join(dir, "fresh-called")
	fresh := filepath.Join(dir, "fresh-stub")
	_ = os.WriteFile(fresh, []byte("#!/usr/bin/env bash\necho \"$*\" >"+called+"\n"), 0o755)
	cmd := exec.Command("bash", filepath.Join(repoRoot(), "scripts", "runtime", "session-restart.sh"),
		"--pane", pane, "--agent", "claude", "--fresh")
	cmd.Env = append(os.Environ(), "TMUX="+socket+",0,0", "AGENT_CTRL_N_FRESH_SH="+fresh,
		"WEZDECK_ATTENTION_STATE_PATH="+attention, "WEZTERM_ATTENTION_LOCK_FILE="+attention+".lock")
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("script: %v\n%s", err, out)
	}
	result := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if k, v, ok := strings.Cut(line, "="); ok {
			result[k] = v
		}
	}
	id := result["session_id"]
	if result["outcome"] != "respawned" || !uuidPattern.MatchString(id) {
		t.Fatalf("output: %q", out)
	}
	if b, _ := os.ReadFile(called); !strings.HasPrefix(string(b), pane+" ") {
		t.Fatalf("respawn not asked for the pane: %q", b)
	}
	opt, _ := exec.Command("tmux", "-S", socket, "show-options", "-pqv", "-t", pane, "@wezdeck_fresh_session_id").Output()
	if strings.TrimSpace(string(opt)) != id {
		t.Fatalf("pane option %q, want %s", opt, id)
	}
	var state struct {
		Entries map[string]any   `json:"entries"`
		Recent  []map[string]any `json:"recent"`
	}
	raw, _ := os.ReadFile(attention)
	_ = json.Unmarshal(raw, &state)
	if _, still := state.Entries["s1"]; still {
		t.Fatalf("old entry still live: %s", raw)
	}
	marked := false
	for _, r := range state.Recent {
		if r["session_id"] == "s1" && r["cleared_to"] == id {
			marked = true
		}
	}
	if !marked {
		t.Fatalf("old entry not cleared_to %s: %s", id, raw)
	}
	// the page on the old id is pointed at the new conversation
	detail, err := sessionDetail([]byte(`{"id":"s1"}`))
	if err != nil {
		t.Fatal(err)
	}
	if m := detail.(map[string]any); m["replaced_by"] != id {
		t.Fatalf("session s1: want replaced_by %s, got %v", id, m)
	}
}

// agent-resume.sh's fresh start reads the id once and starts
// `claude --session-id <it>`
func TestAgentResumeFreshUsesHandedID(t *testing.T) {
	dir, socket, pane, _ := restartFixture(t)
	const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
	_ = exec.Command("tmux", "-S", socket, "set-option", "-p", "-t", pane, "@wezdeck_fresh_session_id", id).Run()
	argv := filepath.Join(dir, "claude-argv")
	bin := filepath.Join(dir, "claude")
	_ = os.WriteFile(bin, []byte("#!/usr/bin/env bash\necho \"$*\" >"+argv+"\n"), 0o755)
	noop := filepath.Join(dir, "noop")
	_ = os.WriteFile(noop, []byte("#!/usr/bin/env bash\n"), 0o755)
	cmd := exec.Command("bash", filepath.Join(repoRoot(), "scripts", "runtime", "agent-resume.sh"),
		"claude", noop, bin, "base", "--permission-mode", "auto")
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "TMUX="+socket+",0,0", "TMUX_PANE="+pane, "WEZDECK_FORCE_FRESH_SESSION=1")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("agent-resume: %v\n%s", err, out)
	}
	if b, _ := os.ReadFile(argv); strings.TrimSpace(string(b)) != "--permission-mode auto --session-id "+id {
		t.Fatalf("claude argv: %q", b)
	}
	opt, _ := exec.Command("tmux", "-S", socket, "show-options", "-pqv", "-t", pane, "@wezdeck_fresh_session_id").Output()
	if strings.TrimSpace(string(opt)) != "" {
		t.Fatalf("the id must be used once, still set: %q", opt)
	}
	// no id handed over: a plain fresh start
	_ = os.Remove(argv)
	cmd2 := exec.Command("bash", filepath.Join(repoRoot(), "scripts", "runtime", "agent-resume.sh"), "claude", noop, bin, "base")
	cmd2.Dir = dir
	cmd2.Env = cmd.Env
	_ = cmd2.Run()
	if b, _ := os.ReadFile(argv); strings.TrimSpace(string(b)) != "" {
		t.Fatalf("plain fresh argv: %q", b)
	}
}
