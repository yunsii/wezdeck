package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestToolKindsAcrossAgents(t *testing.T) {
	cases := []struct {
		agent, tool string
		input       map[string]any
		want        string
	}{
		{"claude", "Bash", map[string]any{"command": "ls"}, toolKindCommand},
		{"claude", "Edit", map[string]any{"file_path": "a", "old_string": "x", "new_string": "y"}, toolKindEdit},
		{"claude", "Read", map[string]any{"file_path": "a"}, toolKindRead},
		{"claude", "TodoWrite", nil, toolKindTodo},
		{"grok", "run_terminal_command", map[string]any{"command": "ls"}, toolKindCommand},
		{"grok", "search_replace", map[string]any{"file_path": "a", "old_string": "x", "new_string": "y"}, toolKindEdit},
		{"grok", "read_file", map[string]any{"path": "a"}, toolKindRead},
		{"grok", "write", map[string]any{"path": "a", "content": "x"}, toolKindWrite},
		{"grok", "ask_user_question", nil, toolKindAsk},
		{"codex", "shell", map[string]any{"command": []any{"ls"}}, toolKindCommand},
		{"codex", "apply_patch", nil, toolKindEdit},
		// unknown names fall back to the shape of the input
		{"codex", "brand_new_editor", map[string]any{"file_path": "a", "old_string": "x", "new_string": "y"}, toolKindEdit},
		{"grok", "brand_new_runner", map[string]any{"command": "make"}, toolKindCommand},
		{"claude", "SomethingElse", map[string]any{}, toolKindOther},
	}
	for _, c := range cases {
		if got := adapterFor(c.agent).ToolKind(c.tool, c.input); got != c.want {
			t.Errorf("%s %s: got %q want %q", c.agent, c.tool, got, c.want)
		}
	}
}

func TestEveryAdapterDeclaresCapabilities(t *testing.T) {
	seen := map[string]bool{}
	for _, a := range agentAdapters {
		if seen[a.Name()] {
			t.Fatalf("duplicate adapter %s", a.Name())
		}
		seen[a.Name()] = true
		caps := a.Capabilities()
		if caps.Usage == "" || caps.MidTurnInput == "" {
			t.Errorf("%s: capabilities must say usage and mid-turn input: %+v", a.Name(), caps)
		}
	}
	// derived, never declared: the hand-written part leaves them alone
	for _, a := range agentAdapters {
		if c := a.Capabilities(); c.AskOptions || c.PlanReview || c.AccountLimits {
			t.Errorf("%s declares a derived capability: %+v", a.Name(), c)
		}
	}
	// claude wires Ask+Plan+Limits; grok Ask+Plan; agy Ask+Limits; codex none yet
	want := map[string][3]bool{
		"claude": {true, true, true},
		"grok":   {true, true, false},
		"agy":    {true, false, true},
		"codex":  {false, false, false},
	}
	for name, on := range want {
		c := capabilitiesOf(adapterFor(name))
		if c.AskOptions != on[0] || c.PlanReview != on[1] || c.AccountLimits != on[2] {
			t.Errorf("%s: ask_options=%v plan_review=%v account_limits=%v, want %v/%v/%v",
				name, c.AskOptions, c.PlanReview, c.AccountLimits, on[0], on[1], on[2])
		}
	}
	if planToolOf("claude") != "ExitPlanMode" || planToolOf("grok") != "" || planToolOf("codex") != "" || planToolOf("nope") != "" {
		t.Error("plan tools")
	}
}

func TestGrokToolMessagesCarryKind(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chat_history.jsonl")
	lines := []string{
		`{"type":"user","content":"改一下"}`,
		`{"type":"assistant","content":"","tool_calls":[{"id":"c1","name":"run_terminal_command","arguments":"{\"command\":\"go test ./...\"}"},{"id":"c2","name":"search_replace","arguments":"{\"file_path\":\"a.go\",\"old_string\":\"x\",\"new_string\":\"y\"}"}]}`,
	}
	_ = os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600)
	tr, err := loadTranscript(path, "grok")
	if err != nil {
		t.Fatal(err)
	}
	kinds := map[string]string{}
	for _, m := range tr.messages {
		if m.Role == "tool" {
			kinds[m.Tool] = m.Kind
		}
	}
	if kinds["run_terminal_command"] != toolKindCommand || kinds["search_replace"] != toolKindEdit {
		t.Fatalf("grok tool kinds: %v (messages %+v)", kinds, tr.messages)
	}
}
