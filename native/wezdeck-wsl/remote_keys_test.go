package main

import "testing"

func TestAllowedKeys(t *testing.T) {
	for _, k := range []string{"Enter", "Escape", "C-c", "C-b", "1", "Tab"} {
		if !allowedKeys[k] {
			t.Errorf("%s should be allowed", k)
		}
	}
	// anything else stays at the desk: no EOF, no suspend, no free text
	for _, k := range []string{"C-d", "C-z", "C-\\", "rm -rf /", "C-b C-b", ""} {
		if allowedKeys[k] {
			t.Errorf("%q must not be allowed", k)
		}
	}
}

func TestToolBackgroundFlag(t *testing.T) {
	tr := &transcript{tools: map[string]int{}}
	for _, l := range []string{
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"fg","name":"Bash","input":{"command":"sleep 60"}}]}}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"bg","name":"Bash","input":{"command":"npm run dev","run_in_background":true}}]}}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"ag","name":"Agent","input":{"prompt":"x","run_in_background":true}}]}}`,
	} {
		tr.feedLine([]byte(l))
	}
	if len(tr.messages) != 3 {
		t.Fatalf("messages: %+v", tr.messages)
	}
	if fg := tr.messages[0]; fg.Background || !fg.Pending {
		t.Errorf("foreground call: %+v", fg)
	}
	if !tr.messages[1].Background || !tr.messages[2].Background {
		t.Errorf("background calls: %+v %+v", tr.messages[1], tr.messages[2])
	}
}
