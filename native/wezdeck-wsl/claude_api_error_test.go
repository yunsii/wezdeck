package main

import (
	"strings"
	"testing"
)

func TestClaudeAPIErrorBecomesSystemErrorRow(t *testing.T) {
	lines := []string{
		`{"type":"user","timestamp":"t0","message":{"role":"user","content":"hello"}}`,
		`{"type":"assistant","timestamp":"t1","isApiErrorMessage":true,"apiErrorStatus":500,"message":{"role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"API Error: 500 {\"error\":{\"type\":\"api_error\",\"message\":\"An unexpected error has occurred.\"}}"}]}}`,
		`{"type":"assistant","timestamp":"t2","message":{"role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"API Error: This organization can't receive replies"}]}}`,
		`{"type":"assistant","timestamp":"t3","message":{"role":"assistant","model":"claude-opus-5-5","content":[{"type":"text","text":"normal reply"}]}}`,
	}
	tr := &transcript{tools: map[string]int{}}
	for _, l := range lines {
		tr.feedLine([]byte(l))
	}
	got := tr.messages
	if len(got) != 4 {
		t.Fatalf("want 4 messages, got %+v", got)
	}
	if got[0].Role != "user" || got[0].Text != "hello" {
		t.Fatalf("user: %+v", got[0])
	}
	if got[1].Role != "system" || got[1].Kind != "error" || !strings.Contains(got[1].Text, "API Error: 500") {
		t.Fatalf("flagged api error: %+v", got[1])
	}
	if got[2].Role != "system" || got[2].Kind != "error" || !strings.Contains(got[2].Text, "organization") {
		t.Fatalf("synthetic api error: %+v", got[2])
	}
	if got[3].Role != "assistant" || got[3].Text != "normal reply" {
		t.Fatalf("normal assistant: %+v", got[3])
	}
}
