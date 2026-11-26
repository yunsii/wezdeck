package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestBuildHandoffBriefFromClaudeTranscript(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "abc.jsonl")
	lines := []string{
		`{"type":"user","message":{"role":"user","content":"重新设计 web 会话"}}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"先调研社区"},{"type":"tool_use","name":"Edit","input":{"file_path":"/tmp/a.go"}}]}}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"直接替换吧"}]}}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"按替换本格落地"}]}}`,
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	e := attentionEntry{SessionID: "abc", AgentName: "ux", GitBranch: "dev/ux",
		TmuxSocket: "/tmp/tmux-1000/default", TmuxSession: "work", TmuxPane: "%9"}
	brief := buildHandoffBrief(e, path, "claude", "grok", "继续做新会话分层")
	for _, want := range []string{
		"[wezdeck 接力] ux（claude → grok）",
		"session_id: abc",
		"transcript:",
		"## 任务",
		"重新设计 web 会话",
		"直接替换吧",
		"## 现状",
		"按替换本格落地",
		"/tmp/a.go",
		"不要 recycle",
		"## 补充",
		"继续做新会话分层",
	} {
		if !strings.Contains(brief, want) {
			t.Fatalf("brief missing %q:\n%s", want, brief)
		}
	}
}

func TestBuildHandoffBriefSkipsSkillInjection(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	_ = os.WriteFile(path, []byte(strings.Join([]string{
		`{"type":"user","message":{"role":"user","content":"Base directory for this skill: /x"}}`,
		`{"type":"user","message":{"role":"user","content":"真任务"}}`,
	}, "\n")+"\n"), 0o600)
	brief := buildHandoffBrief(attentionEntry{SessionID: "s"}, path, "claude", "codex", "")
	if strings.Contains(brief, "Base directory") {
		t.Fatalf("skill injection leaked:\n%s", brief)
	}
	if !strings.Contains(brief, "真任务") {
		t.Fatalf("real user turn missing:\n%s", brief)
	}
}

func TestStartSessionHandoffRejectsSameAgent(t *testing.T) {
	dir, socket, pane, _ := restartFixture(t)
	stub := filepath.Join(dir, "handoff-stub")
	_ = os.WriteFile(stub, []byte("#!/usr/bin/env bash\necho should-not-run\nexit 1\n"), 0o755)
	t.Setenv("WEZDECK_SESSION_HANDOFF_CMD", stub)
	// attention already has s1 as claude; pretend transcript is claude by writing one
	home := t.TempDir()
	t.Setenv("HOME", home)
	proj := filepath.Join(home, ".claude", "projects", "-x")
	_ = os.MkdirAll(proj, 0o755)
	_ = os.WriteFile(filepath.Join(proj, "s1.jsonl"), []byte("{}\n"), 0o600)
	_ = socket
	_ = pane
	if _, err := startSessionHandoff([]byte(`{"id":"s1","to":"claude"}`)); err == nil || !strings.Contains(err.Error(), "already on claude") {
		t.Fatalf("want already on claude, got %v", err)
	}
}

func TestStartSessionHandoffRunsStubAndPastes(t *testing.T) {
	dir, socket, pane, _ := restartFixture(t)
	record := filepath.Join(dir, "argv")
	stub := filepath.Join(dir, "handoff-stub")
	_ = os.WriteFile(stub, []byte(`#!/usr/bin/env bash
printf '%s|%s\n' "$*" "$TMUX" >>`+record+`
# leave a non-shell pane with a stable screen so waitAgentReady can pass
tmux respawn-pane -k -t "$2" "sh" "-c" "echo ready; exec cat"
echo outcome=respawned
echo agent=grok
`), 0o755)
	t.Setenv("WEZDECK_SESSION_HANDOFF_CMD", stub)
	home := t.TempDir()
	t.Setenv("HOME", home)
	proj := filepath.Join(home, ".claude", "projects", "-x")
	_ = os.MkdirAll(proj, 0o755)
	_ = os.WriteFile(filepath.Join(proj, "s1.jsonl"), []byte(
		`{"type":"user","message":{"role":"user","content":"hello handoff"}}`+"\n"), 0o600)

	res, err := startSessionHandoff([]byte(`{"id":"s1","to":"grok","note":"go"}`))
	if err != nil {
		t.Fatal(err)
	}
	jobID, _ := res.(map[string]any)["job"].(string)
	if jobID == "" {
		t.Fatalf("no job: %v", res)
	}
	deadline := time.Now().Add(20 * time.Second)
	var stage, jobErr string
	for time.Now().Before(deadline) {
		st, err := handoffJobStatus([]byte(`{"job":"` + jobID + `"}`))
		if err != nil {
			t.Fatal(err)
		}
		j := st.(map[string]any)["job"].(handoffJob)
		stage, jobErr = j.Stage, j.Error
		if stage == "done" || stage == "failed" {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if stage != "done" {
		t.Fatalf("stage=%s err=%s", stage, jobErr)
	}
	got, _ := os.ReadFile(record)
	line := strings.TrimSpace(string(got))
	if !strings.Contains(line, "--pane "+pane) || !strings.Contains(line, "--to grok") ||
		!strings.HasSuffix(line, "|"+socket+",0,0") {
		t.Fatalf("argv/TMUX: %q", line)
	}
	screen, _ := exec.Command("tmux", "-S", socket, "capture-pane", "-p", "-t", pane).Output()
	if !strings.Contains(string(screen), "wezdeck 接力") && !strings.Contains(string(screen), "hello handoff") {
		t.Fatalf("brief not pasted:\n%s", screen)
	}
}

func TestHandoffJobUnknown(t *testing.T) {
	if _, err := handoffJobStatus([]byte(`{"job":"nope"}`)); err == nil {
		t.Fatal("expected unknown job")
	}
}

func TestStartSessionHandoffBadTo(t *testing.T) {
	if _, err := startSessionHandoff([]byte(`{"id":"s1","to":"gemini"}`)); err == nil {
		t.Fatal("expected bad to")
	}
}

func TestHandoffBriefJSONRoundTripShape(t *testing.T) {
	// ensure handoffJob marshals the exported fields the web polls
	j := handoffJob{ID: "j1", Stage: "done", FromID: "s1", FromAgent: "claude", ToAgent: "grok",
		Worktree: "/x", Pane: "%1", Brief: "[wezdeck 接力] x"}
	b, err := json.Marshal(j)
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	for _, want := range []string{`"job":"j1"`, `"stage":"done"`, `"from_id":"s1"`, `"to_agent":"grok"`, `"brief":`} {
		if !strings.Contains(s, want) {
			t.Fatalf("missing %s in %s", want, s)
		}
	}
}

func TestStartSessionHandoffJobCarriesBrief(t *testing.T) {
	dir, _, _, _ := restartFixture(t)
	stub := filepath.Join(dir, "handoff-stub")
	_ = os.WriteFile(stub, []byte(`#!/usr/bin/env bash
tmux respawn-pane -k -t "$2" "sh" "-c" "echo ready; exec cat"
echo outcome=respawned
echo agent=grok
`), 0o755)
	t.Setenv("WEZDECK_SESSION_HANDOFF_CMD", stub)
	home := t.TempDir()
	t.Setenv("HOME", home)
	proj := filepath.Join(home, ".claude", "projects", "-x")
	_ = os.MkdirAll(proj, 0o755)
	_ = os.WriteFile(filepath.Join(proj, "s1.jsonl"), []byte(
		`{"type":"user","message":{"role":"user","content":"hello handoff"}}`+"\n"), 0o600)

	res, err := startSessionHandoff([]byte(`{"id":"s1","to":"grok"}`))
	if err != nil {
		t.Fatal(err)
	}
	jobID := res.(map[string]any)["job"].(string)
	deadline := time.Now().Add(15 * time.Second)
	var brief string
	for time.Now().Before(deadline) {
		st, err := handoffJobStatus([]byte(`{"job":"` + jobID + `"}`))
		if err != nil {
			t.Fatal(err)
		}
		j := st.(map[string]any)["job"].(handoffJob)
		if j.Brief != "" {
			brief = j.Brief
		}
		if j.Stage == "done" || j.Stage == "failed" {
			if j.Stage == "failed" {
				t.Fatalf("failed: %s", j.Error)
			}
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !strings.Contains(brief, "wezdeck 接力") || !strings.Contains(brief, "hello handoff") {
		t.Fatalf("brief missing content: %q", brief)
	}
}
