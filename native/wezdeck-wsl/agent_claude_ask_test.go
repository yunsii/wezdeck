package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPendingClaudeElicitation(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	ask := `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"AskUserQuestion","input":{"questions":[{"question":"默认首页？","header":"首页","multiSelect":false,"options":[{"label":"会话","description":"d"},{"label":"工单"}]},{"question":"节奏？","header":"节奏","options":[{"label":"分三次"},{"label":"一次"}]}]}}]}}` + "\n"
	os.WriteFile(path, []byte(`{"type":"user","message":{"content":"hi"}}`+"\n"+ask), 0o600)
	el := pendingClaudeElicitation(path)
	if el == nil || el.ToolCallID != "toolu_1" || len(el.Questions) != 2 {
		t.Fatalf("pending ask: %+v", el)
	}
	if q := el.Questions[0]; q.Header != "首页" || len(q.Options) != 2 || q.Options[0].Description != "d" {
		t.Fatalf("question 0: %+v", q)
	}
	answer := `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"ok"}]}}` + "\n"
	os.WriteFile(path, []byte(ask+answer), 0o600)
	if el := pendingClaudeElicitation(path); el != nil {
		t.Fatalf("answered ask still pending: %+v", el)
	}
	if pendingClaudeElicitation(filepath.Join(dir, "missing.jsonl")) != nil {
		t.Fatal("missing transcript")
	}
}

func TestAskReviewing(t *testing.T) {
	if !askReviewing("Review your answers\n\n● 默认首页？ → 会话\n\nReady to submit your answers?\n❯ 1. Submit answers\n  2. Cancel") {
		t.Fatal("review page")
	}
	if askReviewing("☐ 首页  ☐ 节奏  ✔ Submit\n\n默认首页？\n❯ 1. 会话") {
		t.Fatal("question page is not review")
	}
}
