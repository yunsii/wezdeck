package main

import (
	"strings"
	"testing"
)

func TestPendingPermissionIsTheNewestOpenCall(t *testing.T) {
	lines := []string{
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"a","name":"Read","input":{"file_path":"/r/x.go"}}]}}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"a","content":"ok"}]}}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"b","name":"Bash","input":{"command":"git push origin master"}}]}}`,
	}
	tr := &transcript{tools: map[string]int{}}
	for _, l := range lines {
		tr.feedLine([]byte(l))
	}
	p := pendingPermission(tr.messages, "ExitPlanMode")
	if p == nil || p.Tool != "Bash" || p.Body != "git push origin master" || p.Plan {
		t.Fatalf("got %+v", p)
	}

	plan := &transcript{tools: map[string]int{}}
	plan.feedLine([]byte(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"p","name":"ExitPlanMode","input":{"plan":"## 计划\n1. 改 A\n2. 改 B"}}]}}`))
	if p := pendingPermission(plan.messages, "ExitPlanMode"); p == nil || !p.Plan || !strings.Contains(p.Body, "1. 改 A") {
		t.Fatalf("plan: %+v", p)
	}

	ask := &transcript{tools: map[string]int{}}
	ask.feedLine([]byte(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"q","name":"AskUserQuestion","input":{"questions":[]}}]}}`))
	if p := pendingPermission(ask.messages, "ExitPlanMode"); p != nil {
		t.Fatalf("a question is not a permission prompt: %+v", p)
	}
	// an agent without a plan tool never shows a call as a plan
	if p := pendingPermission(plan.messages, ""); p == nil || p.Plan {
		t.Fatalf("plan without a plan tool: %+v", p)
	}
	if pendingPermission(nil, "") != nil {
		t.Fatal("nothing open, nothing to ask")
	}
}
