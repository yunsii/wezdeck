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

func TestArchivedCodexSessionWithNoAgentPane(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	state := filepath.Join(dir, "attention.json")
	t.Setenv("WEZDECK_ATTENTION_FILE", state)
	transcripts := filepath.Join(dir, ".codex", "sessions", "2026", "11", "26")
	if err := os.MkdirAll(transcripts, 0700); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"tracked", "untracked"} {
		content := `{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"text":"done"}]}}` + "\n"
		if err := os.WriteFile(filepath.Join(transcripts, "rollout-2026-11-26T09-49-10-"+id+".jsonl"), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	setArchiveTime := func(at time.Time) {
		t.Helper()
		stateJSON, err := json.Marshal(map[string]any{"recent": []map[string]any{
			{"session_id": "tracked", "last_status": "done", "archived_ts": at.UnixMilli(),
				"tmux_socket": filepath.Join(dir, "missing"), "tmux_pane": "%0", "agent_name": "codex"},
		}})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(state, stateJSON, 0600); err != nil {
			t.Fatal(err)
		}
	}
	setArchiveTime(time.Now())
	args := json.RawMessage(`{"id":"tracked"}`)
	reply := dispatch(request{Version: 2, Domain: "remote", Action: "session", Payload: args})
	if !reply.OK {
		t.Fatalf("local session read: %s", reply.Error)
	}
	detail := reply.Result.(map[string]any)
	if detail["read_only"] != true || detail["focus"] != nil || detail["screen"] != nil {
		t.Fatalf("expected transcript-only detail, got %#v", detail)
	}
	messages := detail["messages"].([]chatMessage)
	if len(messages) != 1 || messages[0].Text != "done" {
		t.Fatalf("unexpected chat: %#v", messages)
	}
	list, err := listSessionsFor(true)
	if err != nil {
		t.Fatal(err)
	}
	cards := list.(map[string]any)["sessions"].([]sessionCard)
	if len(cards) != 1 || cards[0].ID != "tracked" {
		t.Fatalf("expected recently finished session in list, got %#v", cards)
	}
	if _, err := guardSession("tracked"); err == nil {
		t.Fatal("archive must not accept writes")
	}
	if _, err := sessionDetail(args); err == nil {
		t.Fatal("remote reads must not open the local archive")
	}
	if remoteList, err := listSessions(); err != nil || len(remoteList.(map[string]any)["sessions"].([]sessionCard)) != 0 {
		t.Fatalf("remote list must exclude the local archive: %#v %v", remoteList, err)
	}
	untracked := dispatch(request{Version: 2, Domain: "remote", Action: "session", Payload: json.RawMessage(`{"id":"untracked"}`)})
	if untracked.OK {
		t.Fatal("a transcript alone must not grant access")
	}
	setArchiveTime(time.Now().Add(-4 * time.Minute))
	list, err = listSessionsFor(true)
	if err != nil || len(list.(map[string]any)["sessions"].([]sessionCard)) != 0 {
		t.Fatalf("old archive must leave the list: %#v %v", list, err)
	}
	if reply := dispatch(request{Version: 2, Domain: "remote", Action: "session", Payload: args}); !reply.OK {
		t.Fatalf("direct read of old archive: %s", reply.Error)
	}
}

func TestTrackedCodexDetailFollowsPaneAvailability(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux unavailable")
	}
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	state := filepath.Join(dir, "attention.json")
	t.Setenv("WEZDECK_ATTENTION_FILE", state)
	socket := filepath.Join(dir, "sock")
	run := func(args ...string) string {
		t.Helper()
		out, err := tmuxCmd(socket, args...).CombinedOutput()
		if err != nil {
			t.Fatalf("tmux %v: %v: %s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	bin, err := exec.LookPath("cat")
	if err != nil {
		t.Fatal(err)
	}
	codex := filepath.Join(dir, "codex")
	if err := os.Symlink(bin, codex); err != nil {
		t.Fatal(err)
	}
	pane := run("new-session", "-d", "-P", "-F", "#{pane_id}", "exec "+codex)
	t.Cleanup(func() { _ = tmuxCmd(socket, "kill-server").Run() })
	transcripts := filepath.Join(dir, ".codex", "sessions", "2026", "11", "26")
	if err := os.MkdirAll(transcripts, 0700); err != nil {
		t.Fatal(err)
	}
	const id = "codex-tracked"
	content := `{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"text":"done"}]}}` + "\n"
	if err := os.WriteFile(filepath.Join(transcripts, "rollout-2026-11-26T09-49-10-"+id+".jsonl"), []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	doc, err := json.Marshal(map[string]any{"entries": map[string]any{id: map[string]string{
		"session_id": id, "status": "waiting", "waiting_kind": "permission_prompt",
		"agent_name": "codex", "tmux_pane": pane, "tmux_socket": socket,
		"tmux_session": run("display-message", "-p", "-t", pane, "#{session_name}"),
	}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(state, doc, 0600); err != nil {
		t.Fatal(err)
	}
	check := func(readOnly bool) {
		t.Helper()
		result, err := sessionDetail(json.RawMessage(`{"id":"codex-tracked"}`))
		if err != nil {
			t.Fatal(err)
		}
		detail := result.(map[string]any)
		if (detail["read_only"] == true) != readOnly || detail["total"] != 1 {
			t.Fatalf("want read_only=%t and transcript, got %#v", readOnly, detail)
		}
		if readOnly && (detail["status"] != "idle" || detail["waiting_kind"] != "" || detail["focus"] != nil || detail["screen"] != nil) {
			t.Fatalf("expected read-only history, got %#v", detail)
		}
		list, err := listSessions()
		if err != nil {
			t.Fatal(err)
		}
		cards := list.(map[string]any)["sessions"].([]sessionCard)
		if len(cards) != 1 || cards[0].ID != id || cards[0].Status != detail["status"] || cards[0].WaitingKind != detail["waiting_kind"] {
			t.Fatalf("list and detail must agree on status, got %+v", cards)
		}
	}
	check(false)
	run("respawn-pane", "-k", "-t", pane, "exec "+bin)
	check(true)
	if _, err := guardSession(id); err == nil {
		t.Fatal("unavailable Codex must reject writes")
	}
	run("respawn-pane", "-k", "-t", pane, "exec bash --noprofile --norc -i")
	recoverArgs := json.RawMessage(`{"id":"codex-tracked","recover":true}`)
	if _, err := restartSession(recoverArgs); err == nil {
		t.Fatal("an unpinned shell must not be replaced")
	}
	run("set-option", "-p", "-t", pane, "@wezterm_agent_session_id", id)
	result, err := sessionDetail(json.RawMessage(`{"id":"codex-tracked"}`))
	if err != nil || result.(map[string]any)["can_recover"] != true {
		t.Fatalf("pinned shell should offer recovery: %v %v", result, err)
	}
	t.Setenv("WEZDECK_REPO", dir)
	runtimeDir := filepath.Join(dir, "scripts", "runtime")
	if err := os.MkdirAll(runtimeDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(runtimeDir, "primary-pane-wrapper.sh"), []byte("exec \"$@\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	launcher := fmt.Sprintf("[[ \"$WEZDECK_RESUME_SESSION_ID\" == %q && \"$1\" == codex ]] || exit 1\nsleep 0.4\nexec %q\n", id, codex)
	if err := os.WriteFile(filepath.Join(runtimeDir, "agent-launcher.sh"), []byte(launcher), 0700); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := restartSession(recoverArgs)
		done <- err
	}()
	deadline := time.Now().Add(2 * time.Second)
	for !strings.Contains(run("display-message", "-p", "-t", pane, "#{pane_start_command}"), "agent-launcher.sh") {
		if time.Now().After(deadline) {
			t.Fatal("recovery did not launch")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if _, err := restartSession(recoverArgs); err == nil {
		t.Fatal("concurrent recovery must not replace the launching pane")
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	check(false)
	if _, err := restartSession(recoverArgs); err == nil {
		t.Fatal("recovery must not replace a running Codex")
	}
}
