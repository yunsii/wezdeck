package main

import (
	"strings"
	"testing"
)

// Since the hand-back protocol the Agent tool_result only points at a
// message; the report is in toolUseResult.handbackReport (foreground) or a
// peer queued_command (background). Either way it shows as the call's result.
func TestClaudeSubagentHandbackShowsTheReport(t *testing.T) {
	pointer := `This agent's report was delivered to you as a message from \"a1\" (its SubagentHandback call). Read it there; it is not repeated here.`
	lines := []string{
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu1","name":"Agent","input":{"description":"读源码","prompt":"x"}}]}}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","content":[{"type":"text","text":"` + pointer + `"}]}]},"toolUseResult":{"agentId":"a1","handbackReport":{"text":"前台报告：结论 A"}}}`,
		// a background agent: the call returns at once, the report comes later
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu2","name":"Agent","input":{"description":"后台跑","prompt":"y","run_in_background":true}}]}}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu2","content":"Async agent launched"}]},"toolUseResult":{"agentId":"a2"}}`,
		`{"type":"attachment","attachment":{"type":"queued_command","prompt":"<agent-message from=\"a2\">…</agent-message>","commandMode":"prompt","origin":{"kind":"peer","from":"a2","body":"[Subagent hand-back] The text below is the final report. The report follows:\n  后台报告第一行\n  - 第二行"}}}`,
		// a peer message from no known call changes nothing and adds no line
		`{"type":"attachment","attachment":{"type":"queued_command","prompt":"x","commandMode":"prompt","origin":{"kind":"peer","from":"zz","body":"[Subagent hand-back] The report follows:\n  ?"}}}`,
	}
	got := parseClaudeTranscript([]byte(strings.Join(lines, "\n")), 20)
	var results []string
	for _, m := range got {
		if m.Role == "user" {
			t.Fatalf("a hand-back must not show as a user line: %+v", m)
		}
		if m.Role == "tool" {
			results = append(results, strings.TrimSpace(m.Result))
		}
	}
	want := []string{"前台报告：结论 A", "后台报告第一行\n- 第二行"}
	if len(results) != 2 || results[0] != want[0] || results[1] != want[1] {
		t.Fatalf("results = %q", results)
	}
}
