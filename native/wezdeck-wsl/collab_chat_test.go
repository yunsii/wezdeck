package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestCollabRunChat_ClaudeAndCodexStreamFallback(t *testing.T) {
	root := t.TempDir()
	t.Setenv("TICKETS_ROOT", root)
	t.Setenv("HOME", t.TempDir())

	// 1. Codex run with stream.jsonl fallback
	codexTicket := "req-20261127-100001-codex1"
	codexRuns := filepath.Join(root, "_data", codexTicket, "runs")
	if err := os.MkdirAll(codexRuns, 0o755); err != nil {
		t.Fatal(err)
	}
	codexRunID := "run-20261127-100002-abc123"
	if err := os.WriteFile(filepath.Join(codexRuns, codexRunID+".json"), []byte(`{
		"run": "run-20261127-100002-abc123",
		"backend": "codex",
		"phase": "implement",
		"role": "worker",
		"session": {"id": "nonexistent-codex-session"}
	}`), 0o644); err != nil {
		t.Fatal(err)
	}
	codexStream := `{"type":"thread.started","thread_id":"nonexistent-codex-session"}
{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Codex is ignoring 2 unrecognized settings"}}
{"type":"item.completed","item":{"id":"item_1","type":"reasoning","text":"Checking API handler"}}
{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Updated the handler and verified tests."}}
{"type":"item.started","item":{"id":"item_3","type":"command_execution","command":"go test ./..."}}
{"type":"item.completed","item":{"id":"item_3","type":"command_execution","command":"go test ./...","aggregated_output":"ok ./...","exit_code":0}}
{"type":"item.completed","item":{"id":"item_4","type":"file_change","changes":[{"path":"api.go","kind":"update"}]}}
`
	if err := os.WriteFile(filepath.Join(codexRuns, codexRunID+".stream.jsonl"), []byte(codexStream), 0o644); err != nil {
		t.Fatal(err)
	}

	raw, err := collabRunChat(json.RawMessage(`{"run":"` + codexRunID + `"}`))
	if err != nil {
		t.Fatalf("collabRunChat codex error: %v", err)
	}
	res := raw.(map[string]any)
	if res["source"] != "stream" {
		t.Fatalf("expected source=stream, got %v", res["source"])
	}
	if res["ticket"] != codexTicket {
		t.Fatalf("expected ticket=%s, got %v", codexTicket, res["ticket"])
	}
	msgs := res["messages"].([]chatMessage)
	if len(msgs) != 4 {
		t.Fatalf("expected 4 messages (thought + assistant + command + file_change), got %d: %+v", len(msgs), msgs)
	}
	if msgs[0].Role != "system" || msgs[0].Kind != "thought" {
		t.Fatalf("expected thought message first, got %+v", msgs[0])
	}
	if msgs[1].Role != "assistant" || msgs[1].Text != "Updated the handler and verified tests." {
		t.Fatalf("expected assistant text, got %+v", msgs[1])
	}
	if msgs[2].Role != "tool" || msgs[2].Pending || msgs[2].Result != "ok ./..." {
		t.Fatalf("expected completed command tool, got %+v", msgs[2])
	}
	if msgs[3].Role != "tool" || msgs[3].File != "api.go" {
		t.Fatalf("expected file_change tool for api.go, got %+v", msgs[3])
	}

	// 2. Claude stream fallback + final.txt fallback
	claudeTicket := "req-20261127-100005-claud1"
	claudeRuns := filepath.Join(root, "_data", claudeTicket, "runs")
	if err := os.MkdirAll(claudeRuns, 0o755); err != nil {
		t.Fatal(err)
	}
	claudeRunID := "run-20261127-100006-def456"
	if err := os.WriteFile(filepath.Join(claudeRuns, claudeRunID+".launch.json"), []byte(`{
		"run": "run-20261127-100006-def456",
		"phase": "research",
		"invocation": {"backend": "claude", "model": "claude-sonnet-5-5"}
	}`), 0o644); err != nil {
		t.Fatal(err)
	}
	claudeStream := `{"type":"system","subtype":"init","session_id":"sess-missing-1"}
{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"Research conclusion ready."}]}}
`
	if err := os.WriteFile(filepath.Join(claudeRuns, claudeRunID+".stream.jsonl"), []byte(claudeStream), 0o644); err != nil {
		t.Fatal(err)
	}

	raw2, err := collabRunChat(json.RawMessage(`{"run":"` + claudeRunID + `","ticket":"` + claudeTicket + `"}`))
	if err != nil {
		t.Fatalf("collabRunChat claude error: %v", err)
	}
	res2 := raw2.(map[string]any)
	if res2["running"] != true {
		t.Fatalf("expected running=true when .json record missing, got %v", res2["running"])
	}
	msgs2 := res2["messages"].([]chatMessage)
	if len(msgs2) != 1 || msgs2[0].Text != "Research conclusion ready." {
		t.Fatalf("unexpected claude messages: %+v", msgs2)
	}

	// 3. Rejects invalid run id
	if _, err := collabRunChat(json.RawMessage(`{"run":"../escape"}`)); err == nil {
		t.Fatal("expected error for path-traversal run id")
	}
}
