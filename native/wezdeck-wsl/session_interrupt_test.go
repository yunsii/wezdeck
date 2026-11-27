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

func TestWebInterruptSettlesOnlyCurrentTurn(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not installed")
	}
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 not installed")
	}
	for agent, notice := range map[string]string{
		"agy":   "  ⎿  Interrupted · What should Antigravity CLI do instead?",
		"codex": "■ Conversation interrupted - use /feedback if something went wrong.",
		"grok":  "    Turn cancelled by user in 14s.",
	} {
		t.Run(agent, func(t *testing.T) {
			dir := t.TempDir()
			socket := filepath.Join(dir, "tmux.sock")
			tmux := func(args ...string) string {
				t.Helper()
				out, err := tmuxCmd(socket, args...).CombinedOutput()
				if err != nil {
					t.Fatalf("tmux %v: %s: %v", args, out, err)
				}
				return strings.TrimSpace(string(out))
			}
			tmux("new-session", "-d", "-s", "test", "-x", "120", "-y", "20",
				"python3", "-u", "-c", `import os, sys, tty
tty.setcbreak(0)
import signal
signal.signal(signal.SIGINT, lambda *_: print(sys.argv[1]))
print(sys.argv[1])
print("ready")
while os.read(0, 1):
    pass
`, notice)
			defer tmuxCmd(socket, "kill-server").Run()
			pane := tmux("display-message", "-p", "-t", "test", "#{pane_id}")
			tmux("set-option", "-p", "-t", pane, "@wezterm_agent_profile", agent)
			deadline := time.Now().Add(2 * time.Second)
			for !strings.Contains(tmux("capture-pane", "-p", "-t", pane), "ready") {
				if time.Now().After(deadline) {
					t.Fatal("fixture never became ready")
				}
				time.Sleep(10 * time.Millisecond)
			}
			state := filepath.Join(dir, "attention.json")
			t.Setenv("WEZDECK_ATTENTION_FILE", state)
			e := attentionEntry{SessionID: "interrupt-fixture", TmuxSocket: socket, TmuxSession: "test",
				TmuxPane: pane, Status: "running", TurnStarted: 100, TS: 100}
			save := func() {
				t.Helper()
				body, err := json.Marshal(map[string]any{"entries": map[string]attentionEntry{e.SessionID: e}})
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(state, body, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			save()
			args := json.RawMessage(`{"id":"interrupt-fixture"}`)
			interruptArgs := json.RawMessage(`{"id":"interrupt-fixture","key":"C-c","interrupt":true}`)
			detail, err := sessionDetail(args)
			if err != nil || detail.(map[string]any)["status"] != "running" {
				t.Fatalf("old notice must not settle this turn: %v %v", detail, err)
			}
			for i := 0; i < 2; i++ {
				reply, err := keyToSession(interruptArgs)
				if err != nil || reply.(map[string]any)["interrupted"] != true {
					t.Fatalf("interrupt: %v %v", reply, err)
				}
			}
			if screen := tmux("capture-pane", "-p", "-t", pane); strings.Count(screen, strings.TrimSpace(notice)) != 2 {
				t.Fatalf("interrupt retry sent another key: %q", screen)
			}
			detail, err = sessionDetail(args)
			if err != nil || detail.(map[string]any)["status"] != "idle" || detail.(map[string]any)["interrupted"] != true {
				t.Fatalf("settled detail: %v %v", detail, err)
			}
			list, err := listSessions()
			if err != nil || list.(map[string]any)["sessions"].([]sessionCard)[0].Status != "idle" {
				t.Fatalf("settled list: %v %v", list, err)
			}
			e.TurnStarted, e.TS = 200, 200
			save()
			detail, err = sessionDetail(args)
			if err != nil || detail.(map[string]any)["status"] != "running" || detail.(map[string]any)["interrupted"] != nil {
				t.Fatalf("next turn: %v %v", detail, err)
			}
		})
	}
}
