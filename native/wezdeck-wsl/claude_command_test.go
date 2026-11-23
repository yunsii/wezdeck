package main

import "testing"

func TestClaudeCommandsBecomeCommandRows(t *testing.T) {
	lines := []string{
		`{"type":"user","timestamp":"t1","message":{"role":"user","content":"<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>opus</command-args>"}}`,
		`{"type":"user","timestamp":"t2","message":{"role":"user","content":"<local-command-stdout>Set model to \u001b[1mOpus 5.5\u001b[22m</local-command-stdout>"}}`,
		`{"type":"system","subtype":"local_command","timestamp":"t3","content":"<command-name>/resume</command-name>\n<command-message>resume</command-message>\n<command-args></command-args>","level":"info"}`,
		`{"type":"system","subtype":"local_command","timestamp":"t4","content":"<local-command-stdout>Resume cancelled</local-command-stdout>"}`,
		`{"type":"user","timestamp":"t5","message":{"role":"user","content":"a normal message"}}`,
		// a skill invoked as a command: message first, name second
		`{"type":"user","timestamp":"t6","message":{"role":"user","content":"<command-message>coco-weekly-report</command-message>\n<command-name>/coco-weekly-report</command-name>"}}`,
		`{"type":"user","isMeta":true,"timestamp":"t7","message":{"role":"user","content":"<local-command-caveat>Caveat</local-command-caveat>"}}`,
	}
	tr := &transcript{tools: map[string]int{}}
	for _, l := range lines {
		tr.feedLine([]byte(l))
	}
	got := tr.messages
	if len(got) != 4 {
		t.Fatalf("want 4 messages, got %+v", got)
	}
	want := []struct{ kind, text, body string }{
		{"slash", "/model opus", "Set model to Opus 5.5"},
		{"slash", "/resume", "Resume cancelled"},
		{"", "a normal message", ""},
		{"slash", "/coco-weekly-report", ""},
	}
	for i, w := range want {
		if got[i].Kind != w.kind || got[i].Text != w.text || got[i].Body != w.body {
			t.Errorf("message %d: got kind=%q text=%q body=%q, want %+v", i, got[i].Kind, got[i].Text, got[i].Body, w)
		}
	}
}
