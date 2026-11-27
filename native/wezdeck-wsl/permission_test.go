package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestPendingPermissionIsTheNewestOpenCall(t *testing.T) {
	lines := []string{
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"a","name":"Read","input":{"file_path":"/r/x.go"}}]}}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"a","content":"ok"}]}}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"b","name":"Bash","input":{"command":"git push origin master","description":"Push current branch to remote"}}]}}`,
	}
	tr := &transcript{tools: map[string]int{}}
	for _, l := range lines {
		tr.feedLine([]byte(l))
	}
	// Settled tool drops rawInput to keep memory flat.
	if tr.messages[0].rawInput != nil {
		t.Fatalf("settled tool call should clear rawInput")
	}
	p := pendingPermission(tr.messages, "ExitPlanMode")
	if p == nil || p.Tool != "Bash" || p.Body != "git push origin master" || p.Summary != "Push current branch to remote" || p.Plan {
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

func TestPendingPermissionPreservesFullCommandSummaryAndFlags(t *testing.T) {
	longSummary := strings.Repeat("验证完整摘要不被截断且不重复首行命令 ", 12) + "END_SUMMARY"
	var scriptLines []string
	for i := 1; i <= 80; i++ {
		scriptLines = append(scriptLines, fmt.Sprintf("echo 'step-%02d: %s'", i, strings.Repeat("x", 35)))
	}
	longScript := strings.Join(scriptLines, "\n") + "\necho FINAL_SENTINEL"

	payload, _ := json.Marshal(map[string]any{
		"step_index": 1,
		"type":       "PLANNER_RESPONSE",
		"tool_calls": []map[string]any{{
			"name": "run_command",
			"args": map[string]any{
				"CommandLine":   longScript,
				"toolSummary":   longSummary,
				"BypassSandbox": true,
			},
		}},
	})
	tr := &transcript{format: "agy", tools: map[string]int{}}
	tr.feedAgy(payload)

	p := pendingPermission(tr.messages, "")
	if p == nil {
		t.Fatal("expected pending call")
	}
	if p.Summary != strings.TrimSpace(longSummary) {
		t.Fatalf("summary clipped or mangled: got len=%d want len=%d", len(p.Summary), len(strings.TrimSpace(longSummary)))
	}
	if len(p.Flags) != 1 || p.Flags[0] != "bypass-sandbox" {
		t.Fatalf("flags = %v, want [bypass-sandbox]", p.Flags)
	}
	if p.Body != longScript {
		t.Fatalf("body should keep full unclipped script without injected flag header (got len=%d want len=%d)", len(p.Body), len(longScript))
	}
	if p.Truncated {
		t.Fatalf("3.5KB script should not be marked truncated")
	}

	// Settling via GENERIC clears rawInput.
	tr.feedAgy([]byte(`{"step_index":2,"type":"GENERIC","content":"ok"}`))
	if tr.messages[0].rawInput != nil {
		t.Fatal("GENERIC settle should clear rawInput")
	}
}

func TestPendingPermissionFullWriteEditMcpAndCap(t *testing.T) {
	// 1. Write file > 40 lines keeps all lines.
	var fileLines []string
	for i := 1; i <= 75; i++ {
		fileLines = append(fileLines, fmt.Sprintf("line %d", i))
	}
	fullFile := strings.Join(fileLines, "\n")
	writeArgs, _ := json.Marshal(map[string]any{
		"Path":    "/tmp/example/big-script.sh",
		"Content": fullFile,
	})
	tr := &transcript{format: "agy", tools: map[string]int{}}
	tr.addTool("w1", "write_file", string(writeArgs), "")
	p := pendingPermission(tr.messages, "")
	if p == nil || p.Summary != "/tmp/example/big-script.sh" || !strings.Contains(p.Body, "line 75") || p.Truncated {
		t.Fatalf("write_file should keep all 75 lines: %+v", p)
	}

	// 2. Unknown / MCP tool pretty-prints full structured JSON args.
	mcpArgs, _ := json.Marshal(map[string]any{
		"cluster": "prod-hk",
		"service": "wezdeck-web",
		"replicas": 3,
	})
	trMcp := &transcript{format: "agy", tools: map[string]int{}}
	trMcp.addTool("m1", "mcp_deploy_service", string(mcpArgs), "")
	pm := pendingPermission(trMcp.messages, "")
	if pm == nil || !strings.Contains(pm.Body, `"cluster": "prod-hk"`) || !strings.Contains(pm.Body, `"replicas": 3`) {
		t.Fatalf("MCP tool should format JSON args into body: %+v", pm)
	}

	// 3. Oversized command (> 64 KiB) clips cleanly and sets Truncated=true.
	hugeArgs, _ := json.Marshal(map[string]any{
		"CommandLine": strings.Repeat("a", permissionBodyCap+100),
		"toolSummary": "Huge script",
	})
	trHuge := &transcript{format: "agy", tools: map[string]int{}}
	trHuge.addTool("h1", "run_command", string(hugeArgs), "")
	ph := pendingPermission(trHuge.messages, "")
	if ph == nil || !ph.Truncated || !strings.HasSuffix(ph.Body, "\n…") {
		t.Fatalf("oversized body should set Truncated=true: %+v", ph)
	}
}
