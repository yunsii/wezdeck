package main

import (
	"encoding/json"
	"os"
	"path/filepath"
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
	list, err := listSessions()
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
	if _, err := sessionDetail(json.RawMessage(`{"id":"untracked"}`)); err == nil {
		t.Fatal("a transcript alone must not grant access")
	}
	setArchiveTime(time.Now().Add(-4 * time.Minute))
	list, err = listSessions()
	if err != nil || len(list.(map[string]any)["sessions"].([]sessionCard)) != 0 {
		t.Fatalf("old archive must leave the list: %#v %v", list, err)
	}
	if _, err := sessionDetail(args); err != nil {
		t.Fatalf("direct read of old archive: %v", err)
	}
}
